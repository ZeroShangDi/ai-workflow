/ai-workflow:w-dev {{task.prompt}}

完成后执行：
curl -s -X POST http://localhost:8787/awf/state -H 'Content-Type: application/json' -d '{"action":"task-status","id":"{{task.id}}","status":"active"}'
curl -s -X POST http://localhost:8787/awf/state -H 'Content-Type: application/json' -d '{"action":"task-result","id":"{{task.id}}","result":"<执行结果>","files":["<产出文件>"]}'
