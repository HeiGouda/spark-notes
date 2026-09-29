# 参与贡献

欢迎改进 Spark。你没有这个仓库的写权限，不能把改动直接推上来。流程是：Fork 一份到你自己的账号，改完后提交 Pull Request，由维护者审核并合并。

## 步骤

1. 在 GitHub 上 Fork `spark-notes`。
2. 克隆你自己的 Fork，不要克隆后直接往上游推送。
3. 从默认分支拉出新分支，例如 `fix-search-highlight`。
4. 在分支上修改。只改这一件事相关的代码。
5. 本地通过下面的检查：
   - `npm test`
   - `npx vue-tsc --noEmit`
   - 在 `src-tauri/` 下执行 `cargo test`
6. 把分支推送到你自己的 Fork。
7. 向上游仓库开 Pull Request，写清要解决的问题和验证方式。

维护者可能要求改提交说明、补测试或调整实现。讨论清楚后才会合并。合并前，请把上游默认分支的新提交合进你的分支，解决冲突。

## 不要提交的内容

- `node_modules/`、`dist/`、`src-tauri/target/`
- API Key、WebDAV 密码、笔记库、`.ttnote/`、应用数据目录里的 `ai-chats/`
- 与本次改动无关的格式化或重命名

## 报告问题

功能建议和缺陷用 GitHub Issue。安全漏洞不要开公开 Issue，按 [SECURITY.md](SECURITY.md) 私下报告。
