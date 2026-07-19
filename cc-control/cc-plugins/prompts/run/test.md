/ai-workflow:w-test 验证任务 [{{task.id}}] {{task.desc}}。通过设 canCommit=true，缺陷回 CODE。

验证通过后执行：
curl -s -X POST http://localhost:8787/awf/state -H 'Content-Type: application/json' -d '{"action":"task-status","id":"{{task.id}}","status":"done"}'
