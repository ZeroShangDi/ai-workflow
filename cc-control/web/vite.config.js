import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// awf web 前端（Vite + React）
// - build：产物输出到 server 静态托管目录 src/server/public（server root/资产由此承载，见 server.cjs T1-093）
// - dev：vite dev 代理 api + WS 到 cc-control Session Server（端口单源经 env，缺省 8787）。
//   同源访问时（浏览器里 base 用相对路径/经 server 承载）无需代理；dev 起 5173 时需把 /run /awf /api 等转发。
const AWF_SERVER = () => process.env.AWF_SERVER || 'http://127.0.0.1:8787';
const changeOrigin = true;

// 会话/API 端点前缀（web client 直接调用的路径；HTTP 转发，WS 端点额外 ws:true）
const PROXY_PREFIXES = ['/run', '/awf', '/api', '/status', '/send', '/cmd', '/respond',
  '/choice', '/ask', '/stop', '/intervene', '/context-ready', '/diagnostics', '/decisions.html', '/ui'];
const WS_PREFIXES = ['/run', '/awf', '/api']; // 含 WS 升级的端点（/run/events 等）

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../src/server/public', // T1-093：产物落 server 托管目录（server.cjs 静态承载 React）
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.AWF_WEB_PORT || 5173),
    proxy: Object.fromEntries(
      PROXY_PREFIXES.map((prefix) => [
        prefix,
        { target: AWF_SERVER(), changeOrigin, ws: WS_PREFIXES.includes(prefix) },
      ]),
    ),
  },
});
