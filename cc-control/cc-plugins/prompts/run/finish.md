/ai-workflow:w-finish 收尾当前里程碑。

完成后执行（替换 <MILESTONE_ID>）：
curl -s -X POST http://localhost:8787/awf/state -H 'Content-Type: application/json' -d '{"action":"milestone","id":"<MILESTONE_ID>","status":"done"}'
curl -s -X POST http://localhost:8787/awf/state -H 'Content-Type: application/json' -d '{"action":"phase","phase":"FINISH"}'
