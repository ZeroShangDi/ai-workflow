# 状态管理

通过 tmux-http 的 `/awf/state` 端点更新 `.awf/state.json`。每个阶段完成后调用对应 action。

## 端点

```
POST http://localhost:8787/awf/state
Content-Type: application/json
```

## 可用 action

### task-status — 更新任务状态

```bash
curl -s -X POST http://localhost:8787/awf/state \
  -H 'Content-Type: application/json' \
  -d '{"action":"task-status","id":"T1","status":"done"}'
```

status 可选值: `pending` | `active` | `done` | `blocked`

### task-result — 记录执行结果和产出文件

```bash
curl -s -X POST http://localhost:8787/awf/state \
  -H 'Content-Type: application/json' \
  -d '{"action":"task-result","id":"T1","result":"已完成搜索功能开发","files":["src/search.ts","src/types.ts"]}'
```

### task-commit — 追加 commit 记录

```bash
curl -s -X POST http://localhost:8787/awf/state \
  -H 'Content-Type: application/json' \
  -d '{"action":"task-commit","id":"T1","hash":"a1b2c3d","message":"feat: 新增搜索功能"}'
```

### phase — 更新当前阶段

```bash
curl -s -X POST http://localhost:8787/awf/state \
  -H 'Content-Type: application/json' \
  -d '{"action":"phase","phase":"CODE"}'
```

### milestone — 标记里程碑完成

```bash
curl -s -X POST http://localhost:8787/awf/state \
  -H 'Content-Type: application/json' \
  -d '{"action":"milestone","id":"M1","status":"done"}'
```

## 执行流程

每个阶段结束时：

1. 执行阶段工作
2. `task-status` 标记任务为 `done`
3. 若有产出文件 → `task-result` 记录
4. 若有 commit → `task-commit` 追加
5. `phase` 推进到下一阶段

## 注意

- 返回 `{"ok":true}` 表示成功，`{"ok":false,"error":"..."}` 表示失败
- 静默成功，无需额外确认
