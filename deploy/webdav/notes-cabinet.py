#!/usr/bin/env python3
"""浏览器里的笔记柜。只管理 /var/www/webdav，不代替 WebDAV 同步。"""

import html
import os
import secrets
import shutil
import subprocess
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

ROOT = Path("/var/www/webdav").resolve()
PASSWD = "/etc/apache2/webdav.passwd"
HOST = "127.0.0.1"
PORT = 8083
PREFIX = "/files"
PREVIEW_LIMIT = 200_000

PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  :root {{
    --night: #17343a;
    --mist: #e4eef0;
    --card: #f7fbfb;
    --ink: #1c2c30;
    --folder: #2f6f72;
    --delete: #b42318;
    --muted: #5f7276;
    --line: #d3e0e2;
  }}
  * {{ box-sizing: border-box; }}
  html, body {{ margin: 0; min-height: 100%; }}
  body {{
    background: var(--mist);
    color: var(--ink);
    font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
    display: flex;
    min-height: 100vh;
  }}
  .spine {{
    width: 4.5rem;
    flex: none;
    background: var(--night);
    color: #f4fbfb;
    display: flex;
    align-items: center;
    justify-content: center;
  }}
  .spine span {{
    writing-mode: vertical-rl;
    font-family: "Songti SC", "STSong", "SimSun", serif;
    font-size: 1.7rem;
    letter-spacing: 0.45em;
  }}
  main {{
    flex: 1;
    padding: 2.2rem 2.4rem 3rem;
    max-width: 52rem;
  }}
  h1 {{
    margin: 0;
    font-family: "Songti SC", "STSong", "SimSun", serif;
    font-size: 2rem;
    font-weight: 600;
  }}
  .note {{ margin: 0.7rem 0 0; color: var(--muted); line-height: 1.6; }}
  .crumbs {{
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 0.2rem;
    margin: 1.4rem 0 0.6rem;
    color: var(--folder);
  }}
  .crumbs a {{ color: inherit; text-underline-offset: 0.18em; }}
  .count {{ color: var(--muted); margin: 0 0 0.8rem; }}
  ul {{ list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }}
  li {{
    display: grid;
    grid-template-columns: 4.5rem 1fr auto auto;
    gap: 0.8rem;
    align-items: center;
    padding: 0.85rem 0.2rem;
    border-bottom: 1px solid var(--line);
    background: transparent;
  }}
  .kind {{ color: var(--muted); font-size: 0.86rem; }}
  .name {{ color: var(--ink); text-decoration: none; font-size: 1.02rem; }}
  .name:hover {{ text-decoration: underline; text-underline-offset: 0.18em; }}
  .meta {{ color: var(--muted); font-size: 0.86rem; white-space: nowrap; }}
  button, .back {{
    font: inherit;
    border: 0;
    background: transparent;
    color: var(--delete);
    cursor: pointer;
    padding: 0.2rem 0.1rem;
    text-decoration: none;
  }}
  .back {{ color: var(--folder); }}
  button:hover, button:focus-visible, .back:focus-visible, a:focus-visible {{
    outline: 2px solid var(--folder);
    outline-offset: 3px;
  }}
  .empty {{ padding: 1.4rem 0; color: var(--muted); }}
  pre {{
    margin: 1rem 0 0;
    padding: 1.1rem 1.2rem;
    background: var(--card);
    border: 1px solid var(--line);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.7;
    font-family: "Cascadia Mono", "Sarasa Mono SC", "Microsoft YaHei", monospace;
    font-size: 0.95rem;
  }}
  .ask {{ margin-top: 1.6rem; font-size: 1.15rem; }}
  .actions {{ display: flex; gap: 1.4rem; margin-top: 1.2rem; align-items: center; }}
  .actions button {{
    background: var(--delete);
    color: white;
    padding: 0.55rem 1rem;
  }}
  img.preview {{ max-width: 100%; margin-top: 1rem; border: 1px solid var(--line); }}
  @media (max-width: 720px) {{
    body {{ display: block; }}
    .spine {{ width: auto; height: 3.2rem; }}
    .spine span {{ writing-mode: horizontal-tb; letter-spacing: 0.35em; font-size: 1.25rem; }}
    main {{ padding: 1.3rem 1rem 2rem; }}
    li {{ grid-template-columns: 1fr auto; }}
    .kind, .meta {{ grid-column: 1 / -1; }}
  }}
  @media (prefers-reduced-motion: reduce) {{
    * {{ transition: none !important; }}
  }}
</style>
</head>
<body>
<div class="spine"><span>笔记柜</span></div>
<main>
{body}
</main>
</body>
</html>
"""


def safe(rel: str) -> Path:
    rel = unquote(rel).replace("\\", "/").strip()
    rel = rel.lstrip("/")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise PermissionError("路径不对")
    path = (ROOT.joinpath(*parts)).resolve() if parts else ROOT
    if path != ROOT and ROOT not in path.parents:
        raise PermissionError("路径不对")
    return path


def rel_of(path: Path) -> str:
    if path == ROOT:
        return ""
    return path.relative_to(ROOT).as_posix()


def href(rel: str, trailing_dir: bool = False) -> str:
    if not rel:
        return PREFIX + "/"
    url = PREFIX + "/" + quote(rel)
    return url + ("/" if trailing_dir else "")


def crumbs(rel: str) -> str:
    bits = ['<a href="/files/">全部笔记</a>']
    acc = []
    for part in [p for p in rel.split("/") if p]:
        acc.append(part)
        bits.append('<a href="{}">{}</a>'.format(href("/".join(acc), True), html.escape(part)))
    return '<nav class="crumbs">' + " / ".join(bits) + "</nav>"


def page(title: str, body: str) -> bytes:
    return PAGE.format(title=html.escape(title), body=body).encode("utf-8")


def human_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


def check_password(user: str, password: str) -> bool:
    if not user or ":" in user or "\n" in user or "\r" in user:
        return False
    try:
        done = subprocess.run(
            ["/usr/bin/htpasswd", "-vb", PASSWD, user, password],
            capture_output=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return done.returncode == 0


def list_body(path: Path) -> str:
    rel = rel_of(path)
    rows = []
    entries = []
    for child in path.iterdir():
        try:
            resolved = child.resolve()
        except OSError:
            continue
        if resolved != ROOT and ROOT not in resolved.parents and resolved != ROOT:
            continue
        if child.name.startswith("."):
            continue
        entries.append(child)
    entries.sort(key=lambda p: (not p.is_dir(), p.name))
    for child in entries:
        name = child.name
        child_rel = rel_of(child)
        kind = "文件夹" if child.is_dir() else "文件"
        link = href(child_rel, child.is_dir())
        if child.is_dir():
            meta = ""
        else:
            st = child.stat()
            when = datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M")
            meta = f"{human_size(st.st_size)} · {when}"
        rows.append(
            "<li><span class='kind'>{}</span><a class='name' href='{}'>{}</a>"
            "<span class='meta'>{}</span><a class='back' href='/files/confirm?path={}'>删除</a></li>".format(
                kind,
                html.escape(link, quote=True),
                html.escape(name),
                html.escape(meta),
                quote(child_rel, safe=""),
            )
        )
    listing = "<ul>" + "".join(rows) + "</ul>" if rows else "<p class='empty'>这个文件夹是空的。</p>"
    return (
        "<h1>笔记柜</h1>"
        "<p class='note'>可以打开和删除服务器上的笔记。从这里删除后，电脑里没改过的同一篇，下次同步会进回收站。</p>"
        + crumbs(rel)
        + f"<p class='count'>{len(entries)} 项</p>"
        + listing
    )


def confirm_body(rel: str, token: str) -> str:
    path = safe(rel)
    if path == ROOT or not path.exists():
        raise FileNotFoundError("找不到")
    name = path.name
    parent = href(rel_of(path.parent), True)
    kind = "文件夹" if path.is_dir() else "文件"
    extra = "里面的内容会一起删掉。" if path.is_dir() else "电脑里没改过的同一篇，下次同步会进回收站。"
    return (
        "<h1>删除</h1>"
        + crumbs(rel_of(path.parent))
        + f"<p class='ask'>删除{kind}「{html.escape(name)}」？{extra}</p>"
        + "<form class='actions' method='post' action='/files/delete'>"
        + f"<input type='hidden' name='path' value='{html.escape(rel, quote=True)}'>"
        + f"<input type='hidden' name='token' value='{html.escape(token, quote=True)}'>"
        + "<button type='submit'>删除</button>"
        + f"<a class='back' href='{html.escape(parent, quote=True)}'>返回</a></form>"
    )


def preview_body(path: Path) -> str:
    rel = rel_of(path)
    parent = href(rel_of(path.parent), True)
    head = (
        "<h1>{}</h1>".format(html.escape(path.name))
        + crumbs(rel_of(path.parent))
        + "<p class='actions'><a class='back' href='{}'>返回</a><a class='back' href='/files/confirm?path={}'>删除</a></p>".format(
            html.escape(parent, quote=True), quote(rel, safe="")
        )
    )
    suffix = path.suffix.lower()
    if suffix in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}:
        return head + "<img class='preview' alt='' src='{}'>".format(html.escape("/dav/" + quote(rel), quote=True))
    if suffix in {".md", ".txt", ".json", ".csv", ".log"} or suffix == "":
        data = path.read_bytes()[: PREVIEW_LIMIT + 1]
        clipped = len(data) > PREVIEW_LIMIT
        text = data[:PREVIEW_LIMIT].decode("utf-8", errors="replace")
        more = "<p class='note'>只显示了前面一部分。</p>" if clipped else ""
        return head + more + "<pre>{}</pre>".format(html.escape(text))
    return head + "<p class='note'>这个文件不能在页面里预览。</p><p><a href='{}'>下载</a></p>".format(
        html.escape("/dav/" + quote(rel), quote=True)
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "notes-cabinet"

    def log_message(self, fmt: str, *args) -> None:
        return

    def cabinet_token(self) -> str:
        for part in self.headers.get("Cookie", "").split(";"):
            key, _, value = part.strip().partition("=")
            if key == "cabinet" and len(value) >= 16 and value.isascii():
                return value
        return secrets.token_urlsafe(18)

    def send_html(self, status: int, title: str, body: str, token: str) -> None:
        payload = page(title, body)
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self'; style-src 'unsafe-inline'")
        self.send_header(
            "Set-Cookie",
            f"cabinet={token}; Path=/files; HttpOnly; Secure; SameSite=Strict",
        )
        self.end_headers()
        self.wfile.write(payload)

    def require_user(self) -> bool:
        header = self.headers.get("Authorization", "")
        if header.startswith("Basic "):
            import base64

            try:
                raw = base64.b64decode(header.split(" ", 1)[1]).decode("utf-8")
                user, password = raw.split(":", 1)
            except (ValueError, UnicodeDecodeError):
                user, password = "", ""
            if check_password(user, password):
                return True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="WebDAV"')
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def rel_from_path(self) -> str:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path == PREFIX:
            return ""
        if not path.startswith(PREFIX + "/"):
            raise PermissionError("路径不对")
        return path[len(PREFIX) + 1 :]

    def do_GET(self) -> None:
        if not self.require_user():
            return
        token = self.cabinet_token()
        parsed = urlparse(self.path)
        try:
            if parsed.path.rstrip("/") == PREFIX + "/confirm":
                rel = parse_qs(parsed.query).get("path", [""])[0]
                self.send_html(200, "删除", confirm_body(rel, token), token)
                return
            rel = self.rel_from_path().strip("/")
            target = safe(rel)
            if not target.exists():
                self.send_html(404, "找不到", "<h1>找不到</h1><p class='note'>这个文件已经不在了。</p><p><a class='back' href='/files/'>返回全部笔记</a></p>", token)
                return
            if target.is_dir():
                self.send_html(200, "笔记柜", list_body(target), token)
                return
            self.send_html(200, target.name, preview_body(target), token)
        except PermissionError:
            self.send_html(400, "路径不对", "<h1>路径不对</h1>", token)
        except FileNotFoundError:
            self.send_html(404, "找不到", "<h1>找不到</h1>", token)
        except OSError:
            self.send_html(404, "找不到", "<h1>找不到</h1>", token)

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_POST(self) -> None:
        if not self.require_user():
            return
        parsed = urlparse(self.path)
        token = self.cabinet_token()
        if parsed.path.rstrip("/") != PREFIX + "/delete":
            self.send_html(404, "找不到", "<h1>找不到</h1>", token)
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > 100_000:
            self.send_html(400, "路径不对", "<h1>路径不对</h1>", token)
            return
        form = parse_qs(self.rfile.read(length).decode("utf-8", errors="replace"))
        cookie = ""
        for part in self.headers.get("Cookie", "").split(";"):
            key, _, value = part.strip().partition("=")
            if key == "cabinet":
                cookie = value
        if not cookie or not secrets.compare_digest(cookie, form.get("token", [""])[0]):
            self.send_html(400, "页面过期", "<h1>页面过期</h1><p class='note'>返回文件夹后重新点删除。</p>", token)
            return
        rel = form.get("path", [""])[0]
        try:
            target = safe(rel)
            if target == ROOT or not target.exists():
                raise FileNotFoundError
            parent = href(rel_of(target.parent), True)
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        except PermissionError:
            self.send_html(400, "路径不对", "<h1>路径不对</h1>", token)
            return
        except OSError:
            self.send_html(500, "没能删除", "<h1>没能删除</h1><p class='note'>文件可能正在被占用。</p>", token)
            return
        self.send_response(303)
        self.send_header("Location", parent)
        self.send_header("Content-Length", "0")
        self.end_headers()


def main() -> None:
    os.umask(0o022)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
