# WebDAV 部署和使用

Spark 用 WebDAV 在电脑、手机和浏览器之间放同一批笔记。部署不是 Docker：在已经用 Caddy 提供 HTTPS 的 Ubuntu 上运行 `deploy/webdav/install.sh`。Apache 只在本机提供 WebDAV，笔记柜是另一个本机上的 Python 进程。对外只经过 Caddy。

同步地址始终是一个：`https://域名/dav`。多个笔记库靠远端目录区分，例如 `spark/工作` 和 `spark/生活`。不要把远端目录留空或写成 `/`，否则这一库会占满整块 WebDAV，别的库的文件会被卷进来。

## 服务器上有什么

| 路径 | 作用 |
| --- | --- |
| `/var/www/webdav` | 笔记文件。`spark/` 下面每个文件夹是一个库 |
| `/var/lib/notes-cabinet/webdav.passwd` | WebDAV 和笔记柜共用的账号。不要放进仓库 |
| `/opt/notes-cabinet/server.py` | 笔记柜程序 |
| `127.0.0.1:8082` | Apache，只给 Caddy 反代 |
| `127.0.0.1:8083` | 笔记柜 |

浏览器打开 `https://域名/dav/` 会进笔记柜。软件同步走同一个地址，但是 WebDAV 协议，不会打开网页。

## 部署

先让 Caddy 给这个域名提供 HTTPS。Caddyfile 里要有一行 `encode gzip`，安装脚本把 WebDAV 配置插在这行后面。没有 Caddyfile，或找不到这一行，脚本会停下来，已经装上的 Apache 不会自动撤掉。

在服务器上、本仓库目录中执行：

```bash
sudo DOMAIN=example.com WEBDAV_USER=账号 WEBDAV_PASSWORD=密码 ./deploy/webdav/install.sh
```

不写 `WEBDAV_USER` 或 `WEBDAV_PASSWORD` 时，脚本会在终端里询问。密码只写入 `/var/lib/notes-cabinet/webdav.passwd`。

脚本会：

- 安装 Apache，打开 WebDAV 和基本认证
- 把 Apache 改成只监听 `127.0.0.1:8082`，并停用其他已启用的 Apache 站点
- 安装并启动笔记柜（systemd 服务 `notes-cabinet`，用户 `www-data`）
- 在 Caddyfile 里加入 `/dav` 和 `/files` 的反代（已经有 `# spark-webdav` 标记时不会重复插入），然后重新加载 Caddy

装好后：

- 软件里的同步地址填 `https://example.com/dav`
- 浏览器打开 `https://example.com/dav/` 进入笔记柜，用刚才的账号登录

### 已经装过旧版

旧版密码在 `/etc/apache2/webdav.passwd`。重新运行安装脚本时，如果新位置还没有密码文件，会把旧文件挪过去。再运行时，`WEBDAV_USER` 对应的密码会被改成这次填的密码；其他账号保留。

只更新笔记柜程序、不改密码时，把 `deploy/webdav/notes-cabinet.py` 拷到 `/opt/notes-cabinet/server.py`，去掉 Windows 换行后执行 `sudo systemctl restart notes-cabinet`。

## 在电脑上同步

打开一个本地文件夹作为笔记库。设置 → 同步 → WebDAV，填写：

- 地址：`https://域名/dav`
- 远端目录：`spark/` 加上这个库的名字，例如 `spark/工作`
- 用户名和密码：服务器上的 WebDAV 账号

保存后点标题栏的同步，选「上传本地改动」。第一次上传会在云端建好这个目录。选「从云端同步」会把云端文件下载到这个本地文件夹。会覆盖或删除文件时，软件先列出清单，确认后才执行。

每个库的密码各自存在这台电脑的系统凭据库里。同一个 WebDAV 账号要在每个库里各填一次。

云端是正本。停止编辑一分钟后的自动上传只处理新增和修改；需要覆盖云端或删除时，仍要在同步菜单里确认。

### 多个库

每个库是电脑上单独的一个文件夹，再对应云端 `spark/` 下的一个文件夹。第二个库不要放在第一个库的文件夹里面，否则会一起被同步上去。

1. 电脑上新建一个本地文件夹，打开它。
2. 地址、用户名、密码与第一个库相同，远端目录写成平级的另一个名字，例如 `spark/生活`。不要写成 `spark`，也不要写成 `/`。
3. 点「上传本地改动」。目录出现后，浏览器里的笔记柜会多出这个库。
4. 手机用同一个地址和同一个远端目录再添加一条。

手机在云端还没有这个目录时会拒绝保存，所以先在电脑上上传。

### 云端已经有笔记，却显示在未归库

远端目录曾经留空时，笔记直接堆在 `/var/www/webdav` 根上。后来把远端目录改成 `spark/某库`，电脑只会新建这个目录，不会把根上的旧文件搬进去。笔记柜于是把根上的文件夹放进「未归库」。

在电脑上把它们传进当前库：

1. 打开这个笔记库在电脑上的文件夹。
2. 在文件资源管理器中显示隐藏的项目。
3. 进入 `.ttnote/sync`，只删除 `state.json`。不要删除 `.ttnote` 文件夹。那里还有同步设置、排序和收藏。
4. 回到 Spark，点同步，选「上传本地改动」。不要选「从云端同步」。
5. 刷新笔记柜，确认这些笔记已经出现在对应的库里。
6. 再到「未归库」把根上的旧副本彻底删除。这一步不能恢复，所以要先确认库里已经有了。

如果检查云端时清单写着要删除电脑上的笔记，取消，不要确认。

## 在手机上查看

安卓版只下载、不改云端。添加笔记库时填写和电脑相同的地址、用户名、密码、远端目录。远端目录必须已经存在。每个库各存一份密码。

改了服务器上的密码之后，电脑和手机里已经保存的密码不会跟着变，要在每个库里重新填写。

## 笔记柜

登录后左侧是这些入口：

- **库**：`spark/` 下的每个文件夹一个。还没有任何 `spark/` 库时，整块 WebDAV 根目录先当作一个库，名字显示为「笔记库」。文件夹在前，其余按电脑上拖好的顺序（`.ttnote/config/order.json`，随笔记库同步）；没排过的按名称接在后面，数字按数值比，字母开头的在汉字前面。
- **回收站**：当前库里删掉的文件。默认保留 30 天；这个库的 `.ttnote/config/retention.json` 里如果有 `trashDays`，用那个天数。`0` 表示不自动清理。打开回收站时会清掉过期文件。恢复时如果原位置已有同名文件，另存为「名字 (恢复)」，不覆盖。彻底删除和清空要再确认。
- **未归库**：已经有 `spark/` 库之后，仍堆在根目录、不属于这些库的文件。这里的删除是彻底删除，不进回收站。`spark` 文件夹本身不能删。
- **账号**：和 WebDAV 同步共用。可以添加账号、改自己的密码、重设别人的密码、删除别人的账号。不能删除正在登录的账号，也不能删除最后一个。密码保存后不再显示。用户名不能空、不能重复、不能含空格或冒号。两次新密码必须一致。

浏览器里不能新建笔记，也不能新建库。新库由电脑上传时建出来。

库里的删除先进入该库的 `.spark-trash/`。电脑里没改过的同一篇，下次从云端同步时会进电脑上的回收站。

## 维护

```bash
sudo systemctl status notes-cabinet
sudo systemctl status apache2
sudo journalctl -u notes-cabinet -n 50 --no-pager
```

本机检查时，笔记柜应要求登录（401），浏览器入口应跳到 `/files/`：

```bash
curl -sI http://127.0.0.1:8083/files/ | head
curl -sI https://域名/dav/ | head
```

改代码后可在仓库里运行 `python deploy/webdav/test_notes_cabinet.py`。它不连接服务器，也不需要 `htpasswd`。
