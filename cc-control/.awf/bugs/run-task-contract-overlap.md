# 重构任务契约重叠导致相邻任务互相等待

- 状态: open
- 优先级: high
- 发现: 2026-09-09 恢复审计
- 关联: T1-105、T1-058、T1-061、历史 T1-038

## 现象

T1-105 原验收同时要求“server 托管 run”与“run.js 提交后由 server 驱动”；T1-058 又专门要求把 run.js 改成提交/订阅/应答。执行 T1-105 时，Agent 因不愿提前做 T1-058 而再次要求选择边界，形成“105 要 058 先切换、058 要 105 先托管”的闭环。

更早的 T1-038 已以“cli 由司机改提交+订阅+应答形态”标 done，但实际只落了 scaffold，live driver 仍在 run.js。这说明任务标题、acceptance 与真实完成层级没有被门禁一致校验。

## 本轮计划修正

- T1-105：严格限定 server 侧前置；不得切换 run.js/run-batch live driver。
- T1-058：只做 CLI driver cutover；依赖 T1-105 的 server 契约测试通过。
- T1-061：只迁移 cutover 后剩余的 state/gate 直写，不再承担 driver cutover。

## 产品修复建议

1. plan 门禁增加“相邻任务 plannedFiles + acceptance 语义重叠”检查。
2. 任务完成门禁必须验证 acceptance，而不能以 scaffold/接口占位替代 live 接线。
3. 新增补偿任务时必须显式说明它修补哪个已完成任务的未兑现验收，并禁止复用错误的 wbsRef。

## 验收

- 相邻任务各有唯一写入边界和可独立验证的完成条件。
- 前置任务完成时不要求修改后置任务的核心文件。
- 测试能区分 scaffold 存在与生产路径真实接线。
