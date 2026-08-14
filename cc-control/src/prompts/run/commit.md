/ai-workflow-code:w-commit 提交任务 [{{task.id}}] {{task.desc}}。检查 canCommit，禁止 Co-Authored-By 和 push。

提交成功后执行（替换 <hash> 和 <msg>）：
curl -s -X POST http://localhost:8787/awf/state -H 'Content-Type: application/json' -d '{"action":"task-commit","id":"{{task.id}}","hash":"<hash>","message":"<msg>"}'
curl -s -X POST http://localhost:8787/awf/state -H 'Content-Type: application/json' -d '{"action":"task-status","id":"{{task.id}}","status":"done"}'
