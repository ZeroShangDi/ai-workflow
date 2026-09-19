> 参考：[obra/superpowers — systematic-debugging](https://github.com/obra/superpowers)

# w-debug

调试流程。系统化地定位和修复 bug。

## 关联 Skill

- **awf-task-context** — 统一读取并应用任务结构化字段
- 调试方法论（四阶段：根因调查 → 模式分析 → 假设验证 → 实施修复）

## 铁律

```
根因未明，不动代码。
```

## 执行流程

1. 输入含 task ID 时，先按 awf-task-context 获取目标、范围、约束和验收
2. 复现问题，收集错误信息
3. 检查最近变更
4. 追踪数据流，定位根因
5. 写失败测试，修复，验证通过

## 红旗信号

- "先快速修一下，后面再查"
- "试试改个 X 看看能不能行"
- 3 次以上失败 → 质疑架构，不是继续试
