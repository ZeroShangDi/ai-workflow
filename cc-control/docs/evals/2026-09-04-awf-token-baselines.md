# AWF 执行消耗基准（2026-09-04）

本页集中记录后续优化使用的真实对照数据。AWF 现在默认单 Agent；只有命令显式带 `--multi-agent` 才启用多 Agent。

## 命令

```bash
# 单 Agent（默认）
node tests/eval/run-eval.mjs --only multi-agent-parallel-short-prompts

# 多 Agent 对照
node tests/eval/run-eval.mjs --only multi-agent-parallel-short-prompts --multi-agent
```

两条命令使用同一 case、同一组 622 字符短 task prompt；区别只有执行模式。

## 已记录数据

| 样本 | 模式 | 墙钟 | 上下文输入 | 输出 | 成本 | 质量 |
|---|---|---:|---:|---:|---:|---|
| 纯文本 DS | 无 AWF | 155s | 约 897.6k | 约 14.5k | $1.09 | PASS |
| AWF short（修复前） | 多 Agent | 198s | 约 3.688m | 约 44.216k | $3.79 | PASS |
| AWF short（批次修复后） | 多 Agent | 142.597s | 2,776,615 | 37,645 | 未取 | PASS |
| AWF short（单 Agent，真实 usage） | 单 Agent | 159s | 约 4.793m | 约 14.6k | $3.16 | PASS |

修复后多 Agent 相对修复前：上下文输入 -24.7%，输出 -14.9%，墙钟 -28.0%。相对纯文本仍为约 3.09 倍上下文输入、2.60 倍输出。

单 Agent 真实 `/usage` 记录：93.1k input、4.7m cache read、14.6k output，API 2m1s，墙钟 2m39s，成本 $3.16。相对修复前多 Agent 的 $3.79，成本下降约 16.6%；但缓存读取约 4.7m，不能据此断言 token 更少。相对纯文本 DS 的 $1.09，单 Agent 仍贵约 2.9 倍。

## 口径

AWF transcript usage 按 transcript + `message.id` 去重；旧报告中按 content block 重复累加的 11.39m、6.605m 不再用于决策。成本和 API 时间只有用户在 Claude Code `/usage` 中提供时才记录，不从 transcript 臆算。

## 原始记录

- [执行诊断与修复实测](../../tests/eval/results/execution-token-diagnosis-20260904.md)
- [手工 usage 对照](../../tests/eval/results/manual-awf-comparison-20260904.md)
- [修复后原始 eval](../../sandbox/eval/multi-agent-parallel-short-prompts-2026-09-04T08-54-42/eval-result.json)
