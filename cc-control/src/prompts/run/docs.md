/ai-workflow-code:w-doc 为任务 [{{task.id}}] {{task.desc}} 更新文档，完成后返回之前阶段。

完成后执行：
curl -s -X POST http://localhost:8787/awf/state -H 'Content-Type: application/json' -d '{"action":"task-result","id":"{{task.id}}","result":"docs 已更新"}'
