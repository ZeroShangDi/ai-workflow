/ai-workflow:w-debug 任务 [{{task.id}}] {{task.desc}}，{{fromPhase}} 阶段出错：{{error.description}}。定位根因并修复。

修完后执行：
curl -s -X POST http://localhost:8787/awf/state -H 'Content-Type: application/json' -d '{"action":"task-status","id":"{{task.id}}","status":"active"}'
