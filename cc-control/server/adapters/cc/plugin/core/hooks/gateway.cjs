#!/usr/bin/env node
'use strict';
/**
 * gateway.cjs — Claude Code hook 网关（plugin/core/hooks/）
 *
 * 职责：把当前 hook 事件转发给 Session Server，并把 server 返回的 ccOutput 透传到 stdout。
 * **hooks.json 里 7 个 hook 全部**经本网关（issue 004-4：此前此处写「普通事件继续用裸 curl」，
 * 与渲染产物不符；裸 curl 只是手工排查时的等价调用，不是配置里的形态）。
 *
 * 协议：
 *   1. 读 stdin 的 hook JSON payload
 *   2. POST http://127.0.0.1:<port>/hook?event=<hook_event_name>[&sid=<run-sid>][&p=<project>]
 *   3. server 响应含顶层 ccOutput → 原样 JSON.stringify(ccOutput) 打到 stdout（Claude Code 作为 hook 输出消费）
 *   4. 否则无任何 stdout 输出、exit 0（与裸 curl 行为一致：不阻断、不报错）
 *   任何网络/解析异常都不阻断会话（恒 exit 0），但**不静默**：见下方 §失败留痕。
 *
 * ── 失败留痕（2026-09-12，issue 009）────────────────────────────────────────
 * 事故：整条 hook 链断掉时**两边都不响** —— server 因缺 `?p` 返回 400 且不落日志，本网关拿到非 2xx 也
 * 静默 exit 0。结果是 run 卡 `still busy (ready timeout)` 死亡，现场却只剩「server.log 里一条 [hook] 都没有」。
 * 故：**失败一律留下一行**（stderr + `<项目>/.awf/logs/hook-gateway.log`），SessionStart 成功也留一行
 * （它是「hook 链是否建立」的唯一判据）。成功且非 SessionStart 的事件不写，避免刷屏。
 * 写日志本身失败不影响 hook 语义（best-effort，绝不抛）。
 *
 * 用法：node "<CLAUDE_PLUGIN_ROOT>/hooks/gateway.cjs" <port>
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HOST = '127.0.0.1';
const TIMEOUT_MS = 2500;

// 端口来自 hook 命令注入的 argv（渲染自 config 单源 port）；CC_PORT 兜底仅测试/手工调用。
// 不再内嵌 8787 默认值 — server 地址一律由调用方下发。非法 → 0（请求失败 → 静默 exit 0，不崩）。
const port = Number.isFinite(Number(process.argv[2]))
  ? Number(process.argv[2])
  : (Number.isFinite(Number(process.env.CC_PORT)) ? Number(process.env.CC_PORT) : 0);

// T1-070：透传 run sid 给 server /hook（bootstrap 为每 run 注入 CC_SID；server 按 sid 路由到槽）。
const SID_QS = process.env.CC_SID ? `&sid=${encodeURIComponent(String(process.env.CC_SID))}` : '';
// 单 server 多项目：透传项目根（bootstrap 注入 CC_PROJECT；server 按 ?p 路由到该项目上下文）。
// **/hook 是写类端点，server 强制要求 ?p**，缺失即 400 丢弃（server.cjs 的 writeNeedsProject）。
const P_QS = process.env.CC_PROJECT ? `&p=${encodeURIComponent(String(process.env.CC_PROJECT))}` : '';

/**
 * 留痕位置：项目 `.awf/logs/hook-gateway.log`（CC_PROJECT / CC_WORKDIR 优先，其次 cwd，最后 tmp）。
 * 刻意不依赖「哪个目录是对的」—— 只要能写下来一个，排查时就有现场。
 */
function hookLogTarget() {
  const roots = [process.env.CC_PROJECT, process.env.CC_WORKDIR, process.cwd()].filter(Boolean);
  for (const root of roots) {
    const dir = path.join(root, '.awf', 'logs');
    try {
      fs.mkdirSync(dir, { recursive: true });
      return path.join(dir, 'hook-gateway.log');
    } catch { /* 试下一个 */ }
  }
  try {
    const dir = path.join(require('node:os').tmpdir(), 'awf-hook-gateway');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'hook-gateway.log');
  } catch { return null; }
}

/**
 * 是否处于 awf run 会话。
 *
 * 只在 run 会话里留痕：普通交互会话（在本仓库里敲代码时）压根不是 run，hook 事件不适用，
 * 端口也没 server —— 那不是故障，记下来只会每次工具调用刷两行（实测 30 秒 10+ 行）。
 * 判据用 CC_SESSION：bootstrap 对它是**无条件赋值**的（CC_PROJECT/CC_AWF_STATE_SERVER 才带条件），
 * 所以「run 会话身份存在」时它一定在；两个都没有 ⇒ 不是 run 会话。
 */
const IS_RUN_SESSION = Boolean(process.env.CC_AWF_STATE_SERVER || process.env.CC_SESSION);

/** 唯一留痕口：stderr（进 Claude Code 会话记录）+ 项目日志文件；本身绝不抛 */
function note(line) {
  if (!IS_RUN_SESSION) return;
  try { process.stderr.write(`[hook-gateway] ${line}\n`); } catch { /* ignore */ }
  const file = hookLogTarget();
  if (file) {
    try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`); } catch { /* ignore */ }
  }
}

/** 读取 stdin 全部内容 */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/** POST 到 server /hook；返回 { status, body, error }（status=0 表示没通：连接失败/超时） */
function postToServer(event, body) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: HOST,
        port,
        path: `/hook?event=${encodeURIComponent(event)}${SID_QS}${P_QS}`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
        res.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
      },
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`请求超时（${TIMEOUT_MS}ms）`)));
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.write(body);
    req.end();
  });
}

async function main() {
  const raw = await readStdin();
  let event = null;
  try {
    event = JSON.parse(raw)?.hook_event_name ?? null;
  } catch {
    event = null;
  }
  if (!event) process.exit(0);

  // 缺 ?p 必然被 server 400 丢掉（/hook 是写类端点）—— 这条以前现场为零，正是 issue 009 的盲区
  if (!P_QS) note(`${event} → CC_PROJECT 缺失：POST /hook 将因缺 ?p 被 server 400 丢弃（端口 ${port}）`);

  const res = await postToServer(event, raw);
  if (res.status === 0) {
    note(`${event} → 投递失败（端口 ${port}）：${res.error || '未知错误'}`);
    process.exit(0);
  }
  if (res.status >= 400) {
    note(`${event} → server 拒绝 HTTP ${res.status}（端口 ${port}）：${String(res.body).slice(0, 300)}`);
    process.exit(0);
  }
  // SessionStart 成功是「hook 链是否建立」的唯一判据，值得每次留一行
  if (event === 'SessionStart') {
    note(`SessionStart → 已投递（端口 ${port}，CC_PROJECT=${process.env.CC_PROJECT || '(缺失)'}）`);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'ccOutput') && parsed.ccOutput != null) {
    process.stdout.write(JSON.stringify(parsed.ccOutput));
  }
  process.exit(0);
}

main();
