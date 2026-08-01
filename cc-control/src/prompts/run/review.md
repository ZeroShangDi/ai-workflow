/ai-workflow:w-review 审查任务 [{{task.id}}] {{task.desc}}。严重问题 status 回 active，轻微记录后推进。

审查通过后执行：
curl -s -X POST http://localhost:8787/awf/state -H 'Content-Type: application/json' -d '{"action":"task-result","id":"{{task.id}}","result":"review 通过"}'
