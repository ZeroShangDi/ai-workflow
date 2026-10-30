---
description: 调试流程：系统化定位并修复 bug
argument-hint: <问题描述>
hint: <问题描述>
---
> 参考：[obra/superpowers — systematic-debugging](https://github.com/obra/superpowers)

# w-debug

定位并修复有证据支持的缺陷。调试方法统一由 `code-debugging` 提供。

1. 输入含 task ID 时，加载 `awf-task-context`，读取目标、范围、约束和验收条件。
2. 加载 `code-debugging`，按其方法复现、调查根因、验证假设并修复。
3. 只在根因证据足以支持修复方向后修改代码；执行相关回归验证。
4. 报告复现条件、根因、修复位置、验证结果及仍未确认的范围。

不要用随机改动代替假设验证；同一方向反复失败且没有新证据时，回到问题定义和边界判断。
