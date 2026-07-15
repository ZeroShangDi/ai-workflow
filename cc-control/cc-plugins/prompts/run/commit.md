/w-commit 提交代码

提交前检查 canCommit = true。
完成后 task.status = "done"，commits[] 追加，canCommit 重置为 false。
禁止 Co-Authored-By 签名，禁止 push。
