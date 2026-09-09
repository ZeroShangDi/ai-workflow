// tests/setup-env-scrub.js — 测试环境 hermitic 化（T1-098 真 run 回归发现）
//
// 背景：awf run 会话会给进程注入 CC_PROJECT/CC_SESSION/CC_PORT/CC_AWF_STATE_SERVER 等 CC_* env。
// 当「真 run 回归」在 run 会话内跑 `npx vitest` 时，这些变量被测试 worker 继承，导致依赖"干净环境"
// 的用例行为漂移（如 awf-state/session MCP 从 offline 被切成 server 模式、run-context 装配读到
// run 的 projectRoot/session、bootstrap/cli-aux/server-app 上下文装配等）。
//
// 修法：每个测试文件加载前，把 CC_* / AWF_* 从 process.env 清掉，使套件无论在外层有无 CC_* 都等价于
// 普通 npm test 的干净基线。需要特定 env 的测试都在文件内显式设置（在各自文件顶层/用例里），不受影响。

for (const key of Object.keys(process.env)) {
  if (key.startsWith('CC_') || key.startsWith('AWF_')) delete process.env[key];
}
