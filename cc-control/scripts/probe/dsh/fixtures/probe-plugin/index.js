/**
 * awf-probe-plugin — AWF × DSH 隔离实验探针（host 半侧）
 *
 * 定位：**实验夹具**，只装进隔离 `DSH_HOME` 的 `awf-probe` profile，不参与产品装配、
 * 不进 AWF 的 ports 名册。它的存在是为了在不碰用户真实 `~/.dsh` 的前提下，把 P2 需要的
 * 平台能力逐项实测出来（P0 的同类夹具曾丢失，故 P2-3 重建并**纳入 git**）。
 *
 * Cordis 插件形态（照 `dsh-webhook-github` 等同代插件）：ESM，具名导出 `name` / `inject` /
 * `apply`；`inject` 里的服务就绪后才进 `apply`（F25：装配必须在激活窗口内，不能放 setTimeout）。
 *
 * 已实现路由（全部 `exact`，避免 prefix 匹配语义不确定）：
 *   GET /api/awf-probe/ping     —— 存活 + 环境事实（DSH_HOME / pid / 启动时刻）
 *   GET /api/awf-probe/services —— root ctx 上可见的服务名（端口能力面基线，对应 F17）
 *
 * 待 P2-4/P2-5 增加：create-session / prompt / cancel / mount-mcp / approval-answerer 等。
 */

export const name = 'awf-probe-plugin';

/** 需要 webServer 就绪才能注册路由（缺它 process 会一直等，不会带着半装配启动） */
export const inject = ['webServer'];

const startedAt = new Date().toISOString();

/** 统一的 JSON 应答 */
function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

/**
 * 列出 root ctx 上可用的服务名（端口能力面基线，F17）。
 *
 * ⚠️ 2026-09-19 实测：`ctx.root.$internal.services` / `ctx.root.services` 都取不到 →
 * 本路由**当前取不到服务清单**。此时一律回 `ok:false`，**不假装成空清单**（未知不装成功）。
 * P2-4 需要能力面时改用 Cordis 的 reflect 接口重取（`cordis/lib/index.js:727` 的
 * "Declared context properties (services and accessors), by name"）。
 */
function listServices(ctx) {
  const root = ctx?.root ?? ctx;
  const services = root?.$internal?.services ?? root?.services ?? root?.reflect?.store;
  if (services && typeof services === 'object' && !Array.isArray(services)) {
    const names = Object.keys(services).filter((k) => k !== 'root');
    if (names.length > 0) return names.sort();
  }
  return null;
}

/**
 * @param {object} ctx Cordis 上下文（已注入 webServer）
 * @param {{ pathPrefix?: string, echo?: string }} [config] profile patch 里的 config
 */
export function apply(ctx, config = {}) {
  const prefix = config.pathPrefix || '/api/awf-probe';

  const routes = [
    {
      id: `${name}: ping`,
      path: `${prefix}/ping`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' });
        return json(res, 200, {
          ok: true,
          plugin: name,
          echo: config.echo ?? null,
          dshHome: process.env.DSH_HOME ?? null,
          profile: process.env.AWF_PROBE_PROFILE ?? null,
          pid: process.pid,
          startedAt,
          now: new Date().toISOString(),
        });
      },
    },
    {
      id: `${name}: services`,
      path: `${prefix}/services`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' });
        const services = listServices(ctx);
        if (!services) {
          return json(res, 501, {
            ok: false,
            error: 'services listing not available on this build',
            note: 'ctx.root 未暴露服务表；待 P2-4 用 cordis reflect 重取。此处**故意失败**，不返回空清单冒充结果',
          });
        }
        return json(res, 200, { ok: true, services });
      },
    },
  ];

  for (const route of routes) {
    // ctx.effect：把注册的 disposer 交给 Cordis 管，插件卸载时自动摘路由
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: route.path,
      handler: route.handler,
    }), route.id);
  }
}
