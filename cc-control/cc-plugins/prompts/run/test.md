/w-test 请验证任务 [{{task.id}}] {{task.desc}}。

- 运行测试（如有）
- 对照需求逐条检查功能完整性
- 检查 exec.files 中的文件

全部通过设 canCommit = true，有缺陷退回 CODE。
