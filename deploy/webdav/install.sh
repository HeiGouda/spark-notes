#!/bin/bash
# 在已经用 Caddy 提供 HTTPS 的 Ubuntu 服务器上部署 WebDAV 和笔记柜。
# Apache 只监听 127.0.0.1:8082，浏览器页面由 127.0.0.1:8083 提供。
# 密码只写入 /etc/apache2/webdav.passwd，不要把密码放进这个仓库。
#
# 在服务器上、本仓库目录中执行：
#   sudo DOMAIN=example.com WEBDAV_USER=账号 WEBDAV_PASSWORD=密码 ./deploy/webdav/install.sh
# 不写 WEBDAV_PASSWORD 时会在终端里询问。
# 软件里的同步地址填 https://域名/dav ，浏览器打开同一地址会进入笔记柜。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DOMAIN="${DOMAIN:-}"
WEBDAV_USER="${WEBDAV_USER:-}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 sudo 运行" >&2
  exit 1
fi
if [[ -z "$DOMAIN" ]]; then
  echo "需要设置 DOMAIN，例如 DOMAIN=example.com" >&2
  exit 1
fi

if [[ -z "$WEBDAV_USER" ]]; then
  read -r -p "WebDAV 用户名: " WEBDAV_USER
fi
if [[ -z "${WEBDAV_PASSWORD:-}" ]]; then
  read -r -s -p "WebDAV 密码: " WEBDAV_PASSWORD
  echo
fi
if [[ -z "$WEBDAV_USER" || -z "$WEBDAV_PASSWORD" ]]; then
  echo "需要用户名和密码" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y apache2 apache2-utils
a2enmod dav dav_fs auth_basic authn_file alias authz_core authz_user headers

mkdir -p /var/www/webdav /var/lock/apache2 /opt/notes-cabinet
chown www-data:www-data /var/www/webdav /var/lock/apache2

if [[ -f /etc/apache2/webdav.passwd ]]; then
  htpasswd -b /etc/apache2/webdav.passwd "$WEBDAV_USER" "$WEBDAV_PASSWORD"
else
  htpasswd -bc /etc/apache2/webdav.passwd "$WEBDAV_USER" "$WEBDAV_PASSWORD"
fi
chgrp www-data /etc/apache2/webdav.passwd
chmod 640 /etc/apache2/webdav.passwd

printf '%s\n' "Listen 127.0.0.1:8082" > /etc/apache2/ports.conf
sed "s/__DOMAIN__/${DOMAIN//\//\\/}/g" "$HERE/webdav.conf" > /etc/apache2/sites-available/webdav.conf
shopt -s nullglob
for site in /etc/apache2/sites-enabled/*; do
  a2dissite "$(basename "$site" .conf)" || true
done
a2ensite webdav
apachectl configtest
systemctl enable apache2
systemctl restart apache2

install -m 644 "$HERE/notes-cabinet.py" /opt/notes-cabinet/server.py
sed -i 's/\r$//' /opt/notes-cabinet/server.py
install -m 644 "$HERE/notes-cabinet.service" /etc/systemd/system/notes-cabinet.service
systemctl daemon-reload
systemctl enable notes-cabinet
systemctl restart notes-cabinet

if [[ ! -f /etc/caddy/Caddyfile ]]; then
  echo "没有 /etc/caddy/Caddyfile。请先让 Caddy 为 ${DOMAIN} 提供 HTTPS，再重新运行。" >&2
  exit 1
fi
cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.webdav
python3 - "$HERE/caddy-snippet.caddy" << 'PY'
import pathlib, sys
snippet = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")
if not snippet.endswith("\n"):
    snippet += "\n"
path = pathlib.Path("/etc/caddy/Caddyfile")
text = path.read_text(encoding="utf-8")
if "# spark-webdav" in text:
    raise SystemExit(0)
needle = "encode gzip"
at = text.find(needle)
if at < 0:
    raise SystemExit("Caddyfile 里需要有一行 encode gzip，WebDAV 配置会插在它后面")
line_end = text.find("\n", at)
if line_end < 0:
    line_end = len(text)
    text += "\n"
path.write_text(text[: line_end + 1] + snippet + text[line_end + 1 :], encoding="utf-8")
PY
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy

echo "已部署。软件同步地址：https://${DOMAIN}/dav"
echo "浏览器打开 https://${DOMAIN}/dav/ 进入笔记柜。"
