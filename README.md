# Spark

Windows / macOS 桌面端 Markdown 笔记软件，笔记以本地 Markdown 文件保存。GitHub 仓库名是 `spark-notes`，以 [MIT 许可证](LICENSE) 发布。

支持 Windows 与 macOS 13 及以上版本。AI 的 API Key、WebDAV 密码和 Git 远程账号在 Windows 上写入凭据管理器，在 macOS 上写入钥匙串；在其他系统上保存凭据会失败。

需求见 [docs/需求文档.md](docs/需求文档.md)，界面定稿设计稿见 [prototype/index.html](prototype/index.html)（风格 A，浅色 + 夜读）。改进代码的方式见 [CONTRIBUTING.md](CONTRIBUTING.md)：先 Fork，再提交 Pull Request。安全漏洞按 [SECURITY.md](SECURITY.md) 私下报告。

## 技术栈

Tauri 2（Rust）+ Vue 3 + TypeScript + Pinia，编辑器 Milkdown，代码高亮 Prism（`@milkdown/plugin-prism` + refractor），一键整理的中英文空格用 `pangu`，AI 对话的 Markdown 显示用 `markdown-it`。

## 开发环境

- Node.js 20+（npm）
- Rust stable（`rustup`）
- Windows：目标 `x86_64-pc-windows-msvc`，Visual Studio 2022 Build Tools（“使用 C++ 的桌面开发”工作负载），WebView2 运行时（Windows 11 自带）
- macOS：Xcode 命令行工具（`xcode-select --install`）；打通用包还需 `rustup target add aarch64-apple-darwin x86_64-apple-darwin`

## macOS 差异

- 窗口使用系统的红黄绿按钮（`src-tauri/tauri.macos.conf.json`），菜单栏提供剪切 / 复制 / 粘贴 / 全选、隐藏、最小化；`Cmd+Q` 先保存笔记再退出，与关闭窗口的流程相同。
- 快捷键里的 Ctrl 对应 Cmd、Alt 对应 Option。和系统冲突的几项改用 macOS 习惯的默认值：重做 `Cmd+Shift+Z`、替换 `Cmd+Option+F`、切换标签页 `Cmd+Shift+]` / `Cmd+Shift+[`、后退 / 前进 `Cmd+[` / `Cmd+]`、引用 `Cmd+Option+Q`。`Cmd+Q`、`Cmd+H`、`Cmd+M`、`Cmd+Tab` 等不能设为快捷键。文件树里 `Cmd+Backspace` 删除。
- Git 依次查找 `PATH`、`/opt/homebrew/bin/git`、`/usr/local/bin/git`；没装命令行工具时 `/usr/bin/git` 会弹出系统的安装提示。
- 没有 Mac 时，可在 GitHub Actions 手动运行“构建 macOS 安装包”，下载产物里的 `.dmg`。安装包未签名，首次打开需在访达里右键“打开”。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm install` | 安装前端依赖 |
| `npm run tauri dev` | 开发模式运行 |
| `npm test` | 前端单元测试（Vitest） |
| `npx vue-tsc --noEmit` | 类型检查 |
| `cargo test`（在 `src-tauri/` 下） | Rust 单元测试 |
| `npm run tauri build` | 打包发布版（`src-tauri/target/release/bundle/` 下：Windows 为 MSI 与 NSIS 安装包，安装界面为简体中文；macOS 为 `.app` 与 `.dmg`） |
| `npm run tauri build -- --target universal-apple-darwin` | macOS 通用包（Apple 芯片 + Intel） |

## 服务器 WebDAV

在已经用 Caddy 提供 HTTPS 的 Ubuntu 上部署同步目录和浏览器里的笔记柜。密码只写进服务器的 `/etc/apache2/webdav.passwd`。

```bash
sudo DOMAIN=example.com WEBDAV_USER=账号 WEBDAV_PASSWORD=密码 ./deploy/webdav/install.sh
```

软件里的同步地址填 `https://域名/dav`。浏览器打开同一地址进入笔记柜，可以查看和删除。笔记文件在服务器的 `/var/www/webdav`。

## 性能验收

需求文档 7.1 的指标用 `scripts/perf/` 中的脚本测量，需要先 `npm run tauri build` 得到发布版：

```powershell
node scripts/perf/gen-vault.mjs $env:TEMP\spark-perf        # 生成 1 万篇笔记（一半带图片）的测试库
node scripts/perf/bench.mjs src-tauri\target\release\Spark.exe $env:TEMP\spark-perf vault   # 完整流程
node scripts/perf/bench.mjs src-tauri\target\release\Spark.exe $env:TEMP\spark-perf idle    # 打开笔记库后的内存
node scripts/perf/bench.mjs src-tauri\target\release\Spark.exe $env:TEMP\spark-perf empty   # 空闲内存
```

- 运行前关闭 Spark。`bench.mjs` 会临时改写应用设置让程序打开测试库，结束（包括出错、Ctrl+C）时自动恢复。
- `gen-vault.mjs` 只会清空空目录或它自己生成过的测试库，不会清空其他目录。
- 内存按“Spark 进程 + WebView2 页面进程”统计；输出里也列出了 WebView2 其他进程，供参考。

## 目录结构

```
src/
  appCommands.ts     应用命令注册（菜单、按钮、快捷键共用）
  session.ts         把标签页、展开状态、排序方式记到本机设置
  components/        标题栏、侧栏文件树、格式工具栏、编辑器、状态栏、右键菜单、命令面板、查找栏、链接输入框、快捷键设置弹窗、AI 对话框（未配置提示、总结、整理结构）、AI 对话（会话列表 ChatList、对话标签页 ChatView）
  editor/            Milkdown 配置、格式工具清单、代码框节点视图、附件（粘贴 / 拖入 / 图片显示）、双向链接节点与补全、大纲导航、高亮、脚注、链接、查找替换、浮动格式条与斜杠菜单、一键整理（tidy.ts）、AI 指令输入框与待确认区域（aiBlock.ts）
  lib/               Front Matter 拆分、换行符、字数、快捷键（匹配 / 录入 / 校验 / 导入导出）、命令注册表、模糊匹配、文件树排序、AI 预设 / 提示词 / 整理结构的核对（ai.ts）、模型上下文长度与 token 估算（aiModels.ts）、对话的数据结构与上下文裁剪（chat.ts）、回复的 Markdown 渲染（markdown.ts）
  stores/            Pinia：settings（应用设置）、vault（笔记库与文件操作）、tabs（标签页、自动保存、跳转历史）、editor、notice、contextMenu、ai（流式请求与取消）、chat（AI 对话的会话、附件、发送与存盘）
  styles/            tokens.css（主题令牌：浅色 / 纸张 / 护眼 / 夜读 / 纯黑，含正文元素配色）、app.css、editor.css
src-tauri/src/
  vault.rs           笔记库扫描、读取、原子写入
  fsops.rs           新建、重命名、移动、移入回收站、附件、笔记库配置
  notes.rs           笔记解析：Front Matter、标签、双向链接、中文二元切分、搜索语法、摘要、链接解析
  index.rs           搜索索引（SQLite FTS5）：增量同步、搜索、标签、反向链接、改名后改写链接
  watch.rs           监听笔记库文件变化
  ai.rs              AI 接口：OpenAI 兼容流式调用（支持图片）、取消、重试与超时、读取服务商模型列表
  secret.rs          凭据存取：Windows 凭据管理器 / macOS 钥匙串
  chat.rs            AI 对话的本机存储（应用数据目录 ai-chats/，会话 JSON 与图片）
  lib.rs             Tauri 命令与插件注册
```

## 数据安全约定

- 保存采用“写临时文件并落盘 → 重命名覆盖”的原子写入。
- 打开笔记时把 YAML Front Matter 原样切出，编辑器只处理正文，保存时原样拼回；同时保留原文件的换行符（LF / CRLF）。
- 只打开不编辑不会写回文件。
- 所有失败都在状态栏提示；关闭标签页或退出时如有保存失败的笔记，会先询问是否放弃修改。
- 重命名、移动、删除之前先保存受影响的已打开笔记；笔记的 `笔记名.assets/` 附件目录始终随笔记一起改名、移动和删除，改名时正文里的附件引用同步改写。
- 删除需确认，移入 `.ttnote/trash/<时间戳>/`（保留原相对路径，并写 `meta.json` 记录原位置）。
- 空段落不写成 `<br />`，保存结果保持纯 Markdown。
- 图片通过 asset 协议显示，只放行当前打开的笔记库目录。

## 已知问题

- **WebView2 的公共开销约 150MB**：GPU 进程、浏览器主进程和工具进程不论界面内容都存在，M10 实测合计私有内存：不打开笔记库 196MB、打开万篇笔记库后 262MB。需求文档 7.1 的内存指标已改为只统计 Spark 进程与页面进程。关闭 GPU 加速（WebView2 参数 `--disable-gpu`）可再省约 70–90MB，输入与打开笔记速度不受影响，但滚动流畅度未验证，暂不采用。
- 启动后第一次全文搜索较慢（最慢约 199ms，接近 200ms 上限），之后的搜索在 50ms 以内。
- 发布版可执行文件约 9.3MB，前端产物 JS 约 1.0MB（含 markdown-it）。
