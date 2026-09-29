# 安全问题

不要在公开 Issue、Pull Request 或讨论区贴 API Key、WebDAV 密码、笔记内容或凭据。

API Key、WebDAV 密码和 Git 远程账号密码只写入 Windows 凭据管理器。Git 拉取、推送时密码经环境变量交给这次启动的 Git 进程，不出现在命令行参数里，也不写进仓库配置。

发现漏洞时，用 GitHub 的私人漏洞报告提交：仓库的 Security → Advisories → Report a vulnerability。请写上影响版本、复现步骤和影响范围。维护者确认并发布修复之前，请不要公开细节。

创建仓库后，在仓库 Settings 的安全设置里打开 Private vulnerability reporting，别人才能看到这个入口。
