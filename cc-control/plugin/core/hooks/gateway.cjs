#!/usr/bin/env node
'use strict';
/**
 * gateway.cjs — Claude Code hook 网关（plugin/core/hooks/）
 *
 * 职责：把当前 hook 事件转发给 Session Server，并把 server 返回的 ccOutput 透传到 stdout。
 * 供需要「回传决策/阻断」的事件使用（Stop、PreToolUse(AskUserQuestion)）；普通事件继续用裸 curl。
 *
 * 协议：
 *   1. 读 stdin 的 hook JSON payload
 *   2. POST http://127.0.0.1:<port>/hook?event=<hook_event_name>，body 为原始 stdin
 *   3. server 响应含顶层 ccOutput → 原样 JSON.stringify(ccOutput) 打到 stdout（Claude Code 作为 hook 输出消费）
 *   4. 否则无任何 stdout 输出、exit 0（与裸 curl 行为一致：不阻断、不报错）
 *   任何网络/解析异常都静默 exit 0，避免 hook 误报。
 *
 * 用法：node "<CLAUDE_PLUGIN_ROOT>/hooks/gateway.cjs" <port>
 */
const http = require('node:http');

const HOST = '127.0.0.1';
const TIMEOUT_MS = 2500;

// 端口来自 hook 命令注入的 argv（渲染自 config 单源 port）；CC_PORT 兜底仅测试/手工调用。
// 不再内嵌 8787 默认值 — server 地址一律由调用方下发。非法 → 0（请求失败 → 静默 exit 0，不崩）。
const port = Number.isFinite(Number(process.argv[2]))
  ? Number(process.argv[2])
  : (Number.isFinite(Number(process.env.CC_PORT)) ? Number(process.env.CC_PORT) : 0);

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

/** POST 到 server /hook，返回响应字符串；异常/超时 → resolve null（调用方静默处理） */
function postToServer(event, body) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: HOST,
        port,
        path: `/hook?event=${encodeURIComponent(event)}`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
        res.on('error', () => resolve(null));
      },
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy());
    req.on('error', () => resolve(null));
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

  const response = await postToServer(event, raw);
  if (response == null) process.exit(0);

  let parsed = null;
  try {
    parsed = JSON.parse(response);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'ccOutput') && parsed.ccOutput != null) {
    process.stdout.write(JSON.stringify(parsed.ccOutput));
  }
  process.exit(0);
}

main();
