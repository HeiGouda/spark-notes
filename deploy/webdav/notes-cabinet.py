#!/usr/bin/env python3
"""浏览器里的笔记柜。只管理 /var/www/webdav，不代替 WebDAV 同步。

同一地址下，spark/ 的每个子目录是一个库。库内删除移入该库的 .spark-trash。
账号和 WebDAV 共用 /var/lib/notes-cabinet/webdav.passwd。
"""

import html
import json
import os
import re
import secrets
import shutil
import subprocess
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

ROOT = Path("/var/www/webdav").resolve()
PASSWD = "/var/lib/notes-cabinet/webdav.passwd"
HOST = "127.0.0.1"
PORT = 8083
PREFIX = "/files"
PREVIEW_LIMIT = 200_000
SPARK = "spark"
ROOT_LIB = "."
TRASH = ".spark-trash"
DEFAULT_TRASH_DAYS = 30
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^\d{6}(?:-\d+)?$")

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
  .app {{ flex: 1; display: flex; min-width: 0; }}
  .rail {{
    width: 16rem;
    flex: none;
    background: #f3f8f8;
    border-right: 1px solid var(--line);
    padding: 1rem 0.7rem 1.2rem;
    display: flex;
    flex-direction: column;
  }}
  .brand {{ padding: 0.2rem 0.55rem 0.8rem; font-weight: 600; }}
  .brand small {{ display: block; font-weight: 400; color: var(--muted); font-size: 0.82rem; }}
  .rail h2 {{
    margin: 0.8rem 0.55rem 0.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--muted);
  }}
  .rail .gap {{ flex: 1; }}
  a.drawer {{
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.1rem 0;
    padding: 0.4rem 0.55rem;
    border-radius: 0.4rem;
    color: inherit;
    text-decoration: none;
    border-left: 3px solid transparent;
  }}
  a.drawer:hover {{ background: #e7f1f2; }}
  a.drawer.on {{ background: var(--card); border-left-color: var(--folder); }}
  a.drawer .nm {{ flex: 1; min-width: 0; }}
  a.drawer .nm b {{ display: block; font-weight: 600; }}
  a.drawer .nm span {{
    display: block;
    color: var(--muted);
    font-size: 0.75rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }}
  .badge {{
    flex: none;
    min-width: 1.2rem;
    padding: 0 0.35rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--muted);
    font-size: 0.75rem;
    text-align: center;
  }}
  main {{ flex: 1; min-width: 0; padding: 1.3rem 1.5rem 2.4rem; }}
  h1 {{
    margin: 0;
    font-family: "Songti SC", "STSong", "SimSun", serif;
    font-size: 1.7rem;
    font-weight: 600;
  }}
  h1 small {{ display: block; margin-top: 0.2rem; font-family: "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 0.82rem; font-weight: 400; color: var(--muted); }}
  .top {{ display: flex; align-items: flex-start; gap: 1rem; justify-content: space-between; }}
  .note {{ margin: 0.7rem 0 0; color: var(--muted); line-height: 1.6; }}
  .err {{ margin: 0.8rem 0 0; color: var(--delete); }}
  .crumbs {{ display: flex; flex-wrap: wrap; gap: 0.35rem 0.2rem; margin: 0.8rem 0 0.4rem; color: var(--folder); }}
  .crumbs a {{ color: inherit; text-underline-offset: 0.18em; }}
  .tools {{ margin: 0; }}
  .search {{
    font: inherit;
    height: 2rem;
    width: 12rem;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink);
    padding: 0 0.55rem;
  }}
  ul {{ list-style: none; margin: 0.6rem 0 0; padding: 0; border-top: 1px solid var(--line); }}
  li {{
    display: grid;
    grid-template-columns: 4.2rem minmax(0, 1fr) auto auto;
    gap: 0.7rem;
    align-items: center;
    padding: 0.75rem 0.15rem;
    border-bottom: 1px solid var(--line);
  }}
  .kind {{ color: var(--muted); font-size: 0.86rem; }}
  .name {{ color: var(--ink); text-decoration: none; }}
  .name:hover {{ text-decoration: underline; text-underline-offset: 0.18em; }}
  .meta {{ color: var(--muted); font-size: 0.86rem; }}
  .soon {{ color: var(--delete); }}
  a.act {{ color: var(--folder); text-underline-offset: 0.18em; }}
  a.danger, button.danger {{ color: var(--delete); }}
  button, .back {{
    font: inherit;
    border: 0;
    background: transparent;
    cursor: pointer;
    padding: 0.2rem 0.1rem;
    text-decoration: none;
  }}
  .back {{ color: var(--folder); }}
  button:hover, button:focus-visible, a:focus-visible, input:focus-visible {{
    outline: 2px solid var(--folder);
    outline-offset: 3px;
  }}
  .empty {{ padding: 2.2rem 0; color: var(--muted); line-height: 1.6; }}
  .empty b {{ display: block; color: var(--ink); font-size: 1.05rem; margin-bottom: 0.3rem; }}
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
  .ask {{ margin-top: 1.2rem; font-size: 1.05rem; line-height: 1.6; }}
  .actions {{ display: flex; gap: 1.2rem; margin-top: 1.2rem; align-items: center; }}
  .actions button.solid {{
    background: var(--delete);
    color: white;
    padding: 0.55rem 1rem;
  }}
  .actions button.go {{
    background: var(--folder);
    color: white;
    padding: 0.55rem 1rem;
  }}
  label {{ display: block; margin-top: 0.9rem; color: var(--muted); font-size: 0.86rem; }}
  input[type="text"], input[type="password"] {{
    font: inherit;
    display: block;
    width: 100%;
    max-width: 24rem;
    margin-top: 0.3rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink);
  }}
  img.preview {{ max-width: 100%; margin-top: 1rem; border: 1px solid var(--line); }}
  @media (max-width: 800px) {{
    body {{ display: block; }}
    .spine {{ width: auto; height: 3.2rem; }}
    .spine span {{ writing-mode: horizontal-tb; letter-spacing: 0.35em; font-size: 1.25rem; }}
    .app {{ display: block; }}
    .rail {{ width: auto; border-right: 0; border-bottom: 1px solid var(--line); }}
    .rail .gap {{ display: none; }}
    main {{ padding: 1.1rem 1rem 2rem; }}
    li {{ grid-template-columns: 1fr auto; }}
    .kind, .meta {{ grid-column: 1 / -1; }}
    .top {{ display: block; }}
    .search {{ width: 100%; margin-top: 0.6rem; }}
  }}
  @media (prefers-reduced-motion: reduce) {{
    * {{ transition: none !important; }}
  }}
</style>
</head>
<body>
<div class="spine"><span>笔记柜</span></div>
<div class="app">
{body}
</div>
</body>
</html>
"""


def e(text: object) -> str:
    return html.escape(str(text), quote=True)


def inside(root: Path, path: Path) -> bool:
    path = path.resolve()
    root = root.resolve()
    return path == root or root in path.parents


def libraries(root: Path) -> list[str]:
    spark = root / SPARK
    if not spark.is_dir():
        return []
    names = []
    for child in spark.iterdir():
        try:
            resolved = child.resolve()
        except OSError:
            continue
        if not inside(root, resolved) or child.name.startswith(".") or not child.is_dir():
            continue
        names.append(child.name)
    names.sort()
    return names


def shown_libraries(root: Path) -> list[str]:
    found = libraries(root)
    if found:
        return found
    return [ROOT_LIB]


def library_dir(root: Path, name: str) -> Path:
    if name == ROOT_LIB:
        if libraries(root):
            raise FileNotFoundError("没有这个笔记库")
        return root.resolve()
    if name not in libraries(root):
        raise FileNotFoundError("没有这个笔记库")
    path = (root / SPARK / name).resolve()
    if path.parent != (root / SPARK).resolve():
        raise PermissionError("路径不对")
    return path


def assert_note_rel(lib: str, rel: str) -> None:
    rel = rel.replace("\\", "/").strip("/")
    if lib == ROOT_LIB and (rel == SPARK or rel.startswith(SPARK + "/")):
        raise PermissionError("路径不对")


def lib_label(name: str) -> tuple[str, str]:
    if name == ROOT_LIB:
        return "笔记库", "/"
    return name, f"spark/{name}"


def loose_entries(root: Path) -> list[Path]:
    if not libraries(root):
        return []
    found = []
    for child in root.iterdir():
        try:
            resolved = child.resolve()
        except OSError:
            continue
        if not inside(root, resolved) or child.name.startswith(".") or child.name == SPARK:
            continue
        found.append(child)
    return sort_children(found, "", load_order(root))


def loose_target(root: Path, name: str) -> Path:
    if not name or "/" in name or "\\" in name or name.startswith(".") or name == SPARK:
        raise PermissionError("路径不对")
    matches = [p for p in loose_entries(root) if p.name == name]
    if not matches:
        raise FileNotFoundError("找不到")
    return matches[0]


def child_in(base: Path, rel: str) -> Path:
    rel = rel.replace("\\", "/").strip()
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if any(p == ".." or p.startswith(".") for p in parts):
        raise PermissionError("路径不对")
    path = base.joinpath(*parts).resolve() if parts else base.resolve()
    base_r = base.resolve()
    if path != base_r and base_r not in path.parents:
        raise PermissionError("路径不对")
    return path


def kind_of(path: Path) -> str:
    if path.is_dir():
        return "文件夹"
    suf = path.suffix.lower()
    if suf in {".md", ".txt"}:
        return "笔记"
    if suf in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}:
        return "图片"
    return "文件"


def human_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


def display_name(filename: str) -> str:
    lower = filename.lower()
    for ext in (".mind.mmd", ".flow.mmd", ".md"):
        if len(filename) > len(ext) and lower.endswith(ext):
            return filename[: -len(ext)]
    return filename


def _han_start(text: str) -> bool:
    for ch in text:
        if ch.isspace():
            continue
        code = ord(ch)
        return (
            0x3400 <= code <= 0x4DBF
            or 0x4E00 <= code <= 0x9FFF
            or 0xF900 <= code <= 0xFAFF
            or 0x20000 <= code <= 0x2A6DF
        )
    return False


def name_key(filename: str) -> tuple:
    """与电脑一致：数字、字母开头在汉字前；数字按数值比；其余不区分大小写。"""
    shown = display_name(filename)
    parts: list[tuple] = []
    chunk: list[str] = []
    digits = False

    def flush() -> None:
        nonlocal chunk, digits
        if not chunk:
            return
        text = "".join(chunk)
        parts.append((0, int(text)) if digits else (1, text.casefold()))
        chunk = []

    for ch in shown:
        is_digit = ch.isdecimal() and ord(ch) < 128
        if chunk and is_digit != digits:
            flush()
        digits = is_digit
        chunk.append(ch)
    flush()
    return (1 if _han_start(shown) else 0, tuple(parts))


def load_order(lib_root: Path) -> dict[str, list[str]]:
    path = lib_root / ".ttnote" / "config" / "order.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    order: dict[str, list[str]] = {}
    for key, value in data.items():
        if isinstance(key, str) and isinstance(value, list):
            order[key] = [item for item in value if isinstance(item, str)]
    return order


def sort_children(children: list[Path], rel: str, order: dict[str, list[str]]) -> list[Path]:
    """文件夹在前。order.json 里列出的按该顺序，没列出的按名称排在后面。"""
    rank = {name: i for i, name in enumerate(order.get(rel, []))}

    def key(path: Path) -> tuple:
        listed = rank.get(path.name)
        return (0 if path.is_dir() else 1, listed if listed is not None else 10**9, name_key(path.name))

    return sorted(children, key=key)


def file_meta(path: Path) -> str:
    if path.is_dir():
        return ""
    st = path.stat()
    when = datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M")
    return f"{human_size(st.st_size)} · {when}"


def trash_days(lib_root: Path) -> int:
    path = lib_root / ".ttnote" / "config" / "retention.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeError):
        return DEFAULT_TRASH_DAYS
    n = data.get("trashDays", DEFAULT_TRASH_DAYS) if isinstance(data, dict) else DEFAULT_TRASH_DAYS
    if isinstance(n, bool) or not isinstance(n, int) or n < 0:
        return DEFAULT_TRASH_DAYS
    return n


def parse_day(text: str) -> date | None:
    if not DAY_RE.match(text):
        return None
    y, m, d = (int(p) for p in text.split("-"))
    try:
        return date(y, m, d)
    except ValueError:
        return None


def prune_trash(lib_root: Path, days: int, today: date | None = None) -> None:
    if days <= 0:
        return
    trash = lib_root / TRASH
    if not trash.is_dir():
        return
    today = today or date.today()
    for day_dir in list(trash.iterdir()):
        deleted = parse_day(day_dir.name)
        if deleted is None or not day_dir.is_dir():
            continue
        if (today - deleted).days > days:
            shutil.rmtree(day_dir, ignore_errors=True)
    if trash.is_dir() and not any(trash.iterdir()):
        trash.rmdir()


def left_label(days: int, deleted: date, today: date | None = None) -> tuple[str, bool]:
    if days <= 0:
        return "不自动清理", False
    today = today or date.today()
    left = days - (today - deleted).days
    if left <= 0:
        return "即将清理", True
    return f"{left} 天后清理", left <= 7


class TrashItem:
    def __init__(self, stamp: str, name: str, rel: str, path: Path, deleted: date):
        self.stamp = stamp
        self.name = name
        self.rel = rel
        self.path = path
        self.deleted = deleted


def trash_items(lib_root: Path) -> list[TrashItem]:
    trash = lib_root / TRASH
    if not trash.is_dir():
        return []
    found = []
    for day_dir in trash.iterdir():
        deleted = parse_day(day_dir.name)
        if deleted is None or not day_dir.is_dir():
            continue
        for time_dir in day_dir.iterdir():
            if not time_dir.is_dir() or not TIME_RE.match(time_dir.name):
                continue
            for dirpath, dirnames, filenames in os.walk(time_dir):
                base = Path(dirpath)
                dirnames[:] = [name for name in dirnames if not name.startswith(".")]
                leaves: list[Path] = []
                if not dirnames and not filenames and base != time_dir:
                    leaves.append(base)
                leaves.extend(base / name for name in filenames if not name.startswith("."))
                for child in leaves:
                    try:
                        if not inside(lib_root, child.resolve()):
                            continue
                    except OSError:
                        continue
                    rel = child.relative_to(time_dir).as_posix()
                    stamp = f"{day_dir.name}/{time_dir.name}/{rel}"
                    found.append(TrashItem(stamp, child.name, rel, child, deleted))
    found.sort(key=lambda item: (item.deleted, item.stamp), reverse=True)
    return found


def trash_item(lib_root: Path, stamp: str) -> TrashItem:
    parts = [p for p in stamp.replace("\\", "/").split("/") if p not in ("", ".")]
    if len(parts) < 3 or parse_day(parts[0]) is None or not TIME_RE.match(parts[1]):
        raise PermissionError("路径不对")
    if any(p == ".." or p.startswith(".") for p in parts):
        raise PermissionError("路径不对")
    path = child_in(lib_root / TRASH, "/".join(parts))
    if not path.exists():
        raise FileNotFoundError("找不到")
    rel = path.relative_to((lib_root / TRASH / parts[0] / parts[1]).resolve()).as_posix()
    return TrashItem("/".join(parts), path.name, rel, path, parse_day(parts[0]) or date.today())


def move_to_trash(lib_root: Path, src: Path, now: datetime | None = None) -> Path:
    now = now or datetime.now()
    rel = src.resolve().relative_to(lib_root.resolve()).as_posix()
    day = now.strftime("%Y-%m-%d")
    tim = now.strftime("%H%M%S")
    dest = lib_root / TRASH / day / tim / rel
    n = 2
    while dest.exists():
        dest = lib_root / TRASH / day / f"{tim}-{n}" / rel
        n += 1
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dest))
    return dest


def restored_name(name: str) -> str:
    dot = name.rfind(".")
    if dot > 0:
        return f"{name[:dot]} (恢复){name[dot:]}"
    return f"{name} (恢复)"


def restore_dest(lib_root: Path, item: TrashItem) -> Path:
    dest = (lib_root / item.rel).resolve()
    base = lib_root.resolve()
    if dest != base and base not in dest.parents and dest != base:
        raise PermissionError("路径不对")
    while dest.exists():
        dest = dest.with_name(restored_name(dest.name))
    return dest


def restore_item(lib_root: Path, item: TrashItem) -> Path:
    dest = restore_dest(lib_root, item)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(item.path), str(dest))
    cleanup_empty(item.path.parent, lib_root)
    return dest


def cleanup_empty(path: Path, stop: Path) -> None:
    stop = stop.resolve()
    while path.exists() and path.resolve() != stop and path.is_dir() and not any(path.iterdir()):
        parent = path.parent
        path.rmdir()
        path = parent


def remove_tree(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink()


def read_users(path: str | None = None) -> list[str]:
    try:
        text = Path(path or PASSWD).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    users = []
    for line in text.splitlines():
        if not line or line.startswith("#") or ":" not in line:
            continue
        users.append(line.split(":", 1)[0])
    return users


def validate_username(name: str) -> str:
    if not name or name != name.strip():
        return "请填写用户名"
    if any(ch in name for ch in " :\r\n\t") or len(name) > 255:
        return "用户名不能有空格或冒号"
    return ""


def account_add_error(name: str, password: str, again: str, existing: list[str]) -> str:
    err = validate_username(name)
    if err:
        return err
    if name in existing:
        return "已经有这个用户名"
    return password_error(password, again)


def account_pass_error(name: str, current: str, old: str, password: str, again: str, existing: list[str], old_ok: bool) -> str:
    if name not in existing:
        return "没有这个账号"
    if name == current:
        if not old:
            return "请填写当前密码"
        if not old_ok:
            return "当前密码不正确"
    return password_error(password, again)


def account_drop_error(name: str, current: str, existing: list[str]) -> str:
    if name == current:
        return "不能删除正在登录的账号"
    if name not in existing:
        return "没有这个账号"
    if len(existing) <= 1:
        return "不能删除最后一个账号"
    return ""


def password_error(password: str, again: str) -> str:
    if not password:
        return "请填写新密码"
    if "\n" in password or "\r" in password or "\x00" in password:
        return "密码不能换行"
    if password != again:
        return "两次密码不一致"
    return ""


def htpasswd_bin() -> str:
    if Path("/usr/bin/htpasswd").exists():
        return "/usr/bin/htpasswd"
    return "htpasswd"


def run_htpasswd(args: list[str], secret: str = "") -> tuple[int, str]:
    done = subprocess.run([htpasswd_bin(), *args], capture_output=True, text=True, timeout=5, check=False)
    err = (done.stderr or done.stdout or "").strip()
    if secret and secret in err:
        err = "htpasswd 失败"
    return done.returncode, err


def verify_password(user: str, password: str, path: str | None = None) -> bool:
    code, _ = run_htpasswd(["-vb", path or PASSWD, user, password], password)
    return code == 0


def save_password(user: str, password: str, path: str | None = None) -> tuple[bool, str]:
    target = path or PASSWD
    flag = "-b" if Path(target).exists() else "-bc"
    code, err = run_htpasswd([flag, target, user, password], password)
    return code == 0, err or "没能保存账号"


def delete_password(user: str, path: str | None = None) -> tuple[bool, str]:
    code, err = run_htpasswd(["-D", path or PASSWD, user])
    return code == 0, err or "没能删除账号"


def page(title: str, body: str) -> bytes:
    return PAGE.format(title=e(title), body=body).encode("utf-8")


def qurl(path: str, **kwargs: str) -> str:
    parts = []
    for key, value in kwargs.items():
        if value is None or value == "":
            continue
        parts.append(f"{quote(key, safe='')}={quote(value, safe='')}")
    return path + (("?" + "&".join(parts)) if parts else "")


def browse(lib: str, rel: str = "", query: str = "") -> str:
    return qurl(PREFIX + "/", lib=lib, p=rel, q=query)


def hidden(token: str, **fields: str) -> str:
    bits = [f"<input type='hidden' name='token' value='{e(token)}'>"]
    for key, value in fields.items():
        bits.append(f"<input type='hidden' name='{e(key)}' value='{e(value)}'>")
    return "".join(bits)


def crumbs(lib: str, rel: str) -> str:
    bits = [f"<a href='{browse(lib)}'>{e(lib_label(lib)[0])}</a>"]
    acc: list[str] = []
    for part in [p for p in rel.split("/") if p]:
        acc.append(part)
        bits.append(f"<a href='{browse(lib, '/'.join(acc))}'>{e(part)}</a>")
    return "<nav class='crumbs'>" + " / ".join(bits) + "</nav>"


def rail(user: str, libs: list[str], current: str, view: str, loose_n: int, trash_n: int, account_n: int) -> str:
    bits = [f"<div class='brand'>当前登录<small>{e(user)}</small></div>", "<h2>库</h2>"]
    if not libs:
        bits.append("<p class='note'>还没有库</p>")
    for name in libs:
        on = " on" if view == "lib" and name == current else ""
        label, sub = lib_label(name)
        bits.append(
            f"<a class='drawer{on}' href='{browse(name)}'><span class='nm'><b>{e(label)}</b><span>{e(sub)}</span></span></a>"
        )
    bits.append("<div class='gap'></div><h2>这个库</h2>")
    if current:
        on = " on" if view == "trash" else ""
        badge = f"<span class='badge'>{trash_n}</span>" if trash_n else ""
        bits.append(
            f"<a class='drawer{on}' href='{qurl(PREFIX + '/trash', lib=current)}'>"
            f"<span class='nm'><b>回收站</b><span>按库的保留天数</span></span>{badge}</a>"
        )
    else:
        bits.append("<p class='note'>上传之后这里会出现回收站</p>")
    on = " on" if view == "loose" else ""
    loose_badge = f"<span class='badge'>{loose_n}</span>" if loose_n else ""
    bits.append(
        f"<a class='drawer warn{on}' href='{PREFIX}/loose'><span class='nm'><b>未归库</b><span>根目录上的旧文件</span></span>{loose_badge}</a>"
    )
    bits.append("<h2>登录</h2>")
    on = " on" if view == "accounts" else ""
    bits.append(
        f"<a class='drawer{on}' href='{PREFIX}/accounts'><span class='nm'><b>账号</b><span>当前 {e(user)}</span></span>"
        f"<span class='badge'>{account_n}</span></a>"
    )
    return "<nav class='rail' aria-label='抽屉'>" + "".join(bits) + "</nav>"


def shell(user: str, libs: list[str], current: str, view: str, loose_n: int, trash_n: int, main: str) -> str:
    return rail(user, libs, current, view, loose_n, trash_n, len(read_users())) + f"<main>{main}</main>"


def row(kind: str, name_html: str, meta: str, action: str) -> str:
    return f"<li><span class='kind'>{e(kind)}</span>{name_html}<span class='meta'>{meta}</span>{action}</li>"


def library_main(root: Path, lib: str, rel: str, query: str) -> str:
    assert_note_rel(lib, rel)
    lib_root = library_dir(root, lib)
    days = trash_days(lib_root)
    prune_trash(lib_root, days)
    folder = child_in(lib_root, rel)
    if not folder.exists() or not folder.is_dir():
        raise FileNotFoundError("找不到")
    children = []
    for child in folder.iterdir():
        try:
            if not inside(root, child.resolve()):
                continue
        except OSError:
            continue
        if child.name.startswith(".") or (lib == ROOT_LIB and child.name == SPARK):
            continue
        children.append(child)
    children = sort_children(children, rel, load_order(lib_root))
    if query:
        children = [c for c in children if query in c.name]
    label, sub = lib_label(lib)
    title = rel.split("/")[-1] if rel else label
    head = f"<div class='top'><div><h1>{e(title)}"
    if not rel:
        head += f"<small>{e(sub)}</small>"
    head += "</h1>"
    if rel:
        head += crumbs(lib, rel)
    head += "</div>"
    head += (
        f"<form class='tools' method='get' action='{PREFIX}/'>"
        f"<input type='hidden' name='lib' value='{e(lib)}'>"
        f"<input type='hidden' name='p' value='{e(rel)}'>"
        f"<input class='search' name='q' value='{e(query)}' placeholder='搜索当前文件夹' aria-label='搜索当前文件夹'>"
        "</form></div>"
    )
    if not children and not query:
        if not rel:
            return head + (
                f"<p class='empty'><b>这个库还是空的</b>在电脑上把笔记上传到 {e(sub)} 之后，文件会出现在这里。浏览器里不能新建笔记。</p>"
            )
        return head + "<p class='empty'><b>这个文件夹是空的</b></p>"
    if not children:
        return head + "<p class='empty'><b>没有匹配的文件</b>换一个词，或清空搜索。</p>"
    rows = []
    for child in children:
        child_rel = child.relative_to(lib_root).as_posix()
        if child.is_dir():
            name = f"<a class='name' href='{browse(lib, child_rel)}'>{e(child.name)}</a>"
        else:
            name = f"<a class='name' href='{qurl(PREFIX + '/open', lib=lib, p=child_rel)}'>{e(child.name)}</a>"
        action = (
            f"<a class='danger' href='{qurl(PREFIX + '/confirm', action='trash', lib=lib, p=child_rel)}'>移入回收站</a>"
        )
        rows.append(row(kind_of(child), name, e(file_meta(child)), action))
    return head + "<ul>" + "".join(rows) + "</ul>"


def open_main(root: Path, lib: str, rel: str) -> str:
    assert_note_rel(lib, rel)
    lib_root = library_dir(root, lib)
    path = child_in(lib_root, rel)
    if not path.exists() or path.is_dir():
        raise FileNotFoundError("找不到")
    parent = path.relative_to(lib_root).parent.as_posix()
    if parent == ".":
        parent = ""
    root_rel = path.resolve().relative_to(root.resolve()).as_posix()
    head = (
        f"<div class='top'><div><p><a class='back' href='{browse(lib, parent)}'>返回</a></p>"
        f"<h1>{e(path.name)}<small>{e(lib_label(lib)[0] + (' / ' + rel if rel else ''))}</small></h1></div>"
        f"<a class='danger' href='{qurl(PREFIX + '/confirm', action='trash', lib=lib, p=rel)}'>移入回收站</a></div>"
        f"<p class='note'>{e(kind_of(path))} · {e(file_meta(path))}</p>"
    )
    suffix = path.suffix.lower()
    if suffix in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}:
        return head + f"<img class='preview' alt='' src='{e('/dav/' + quote(root_rel))}'>"
    if suffix in {".md", ".txt", ".json", ".csv", ".log"} or suffix == "":
        data = path.read_bytes()[: PREVIEW_LIMIT + 1]
        clipped = len(data) > PREVIEW_LIMIT
        text = data[:PREVIEW_LIMIT].decode("utf-8", errors="replace")
        more = "<p class='note'>只显示了前面一部分。</p>" if clipped else ""
        return head + more + f"<pre>{e(text)}</pre>"
    return head + f"<p class='note'>这个文件不能在页面里预览。</p><p><a href='{e('/dav/' + quote(root_rel))}'>下载</a></p>"


def trash_main(root: Path, lib: str) -> str:
    lib_root = library_dir(root, lib)
    days = trash_days(lib_root)
    prune_trash(lib_root, days)
    items = trash_items(lib_root)
    keep = "不自动清理" if days <= 0 else f"保留 {days} 天"
    head = (
        f"<div class='top'><h1>回收站<small>{e(lib_label(lib)[0])} · {keep}</small></h1>"
    )
    if items:
        head += (
            f"<form method='get' action='{PREFIX}/confirm'>"
            f"<input type='hidden' name='action' value='empty'>"
            f"<input type='hidden' name='lib' value='{e(lib)}'>"
            f"<button class='danger' type='submit'>清空</button></form>"
        )
    head += "</div>"
    if not items:
        stay = "直到彻底删除" if days <= 0 else f"保留 {days} 天，之后自动清掉"
        return head + f"<p class='empty'><b>回收站是空的</b>从这个库删除的笔记和附件会在这里{stay}。</p>"
    today = date.today()
    rows = []
    for item in items:
        label, soon = left_label(days, item.deleted, today)
        klass = "soon" if soon else ""
        meta = f"{e(item.rel)} · {e(item.deleted.isoformat())} · <span class='{klass}'>{e(label)}</span>"
        action = (
            f"<span><a class='act' href='{qurl(PREFIX + '/confirm', action='restore', lib=lib, stamp=item.stamp)}'>恢复</a> "
            f"<a class='danger' href='{qurl(PREFIX + '/confirm', action='purge', lib=lib, stamp=item.stamp)}'>彻底删除</a></span>"
        )
        rows.append(row(kind_of(item.path), f"<span class='name'>{e(item.name)}</span>", meta, action))
    return head + "<ul>" + "".join(rows) + "</ul>"


def loose_main(root: Path) -> str:
    items = loose_entries(root)
    head = "<div class='top'><h1>未归库<small>WebDAV 根目录 · 不属于 spark 下的库</small></h1></div>"
    if not items:
        return head + "<p class='empty'><b>根目录上没有散落的文件</b>库都在 spark 下面。不要把 spark 本身设成一个库。</p>"
    rows = []
    for item in items:
        action = f"<a class='danger' href='{qurl(PREFIX + '/confirm', action='loose', name=item.name)}'>彻底删除</a>"
        rows.append(row(kind_of(item), f"<span class='name'>{e(item.name)}</span>", e(file_meta(item)), action))
    note = "<p class='note'>这些是还堆在根目录的旧文件。彻底删除后不能恢复，也不会进回收站。留下 spark 文件夹。</p>"
    return head + note + "<ul>" + "".join(rows) + "</ul>"


def accounts_main(current: str) -> str:
    users = read_users()
    head = (
        f"<div class='top'><h1>账号<small>笔记柜和同步共用 · 当前登录 {e(current)}</small></h1>"
        f"<a class='act' href='{PREFIX}/accounts/new'>添加账号</a></div>"
        "<p class='note'>密码保存后不再显示。改密码后，电脑和手机里每个库保存的旧密码要各自重填。</p>"
    )
    rows = []
    for name in users:
        self = name == current
        links = f"<a class='act' href='{qurl(PREFIX + '/accounts/password', user=name)}'>{'改密码' if self else '重设密码'}</a>"
        if not self and len(users) > 1:
            links += f" <a class='danger' href='{qurl(PREFIX + '/confirm', action='drop', user=name)}'>删除</a>"
        rows.append(
            row(
                "当前" if self else "账号",
                f"<span class='name'>{e(name)}</span>",
                "正在登录" if self else "可登录、可同步",
                f"<span>{links}</span>",
            )
        )
    return head + "<ul>" + "".join(rows) + "</ul>"


def account_form(current: str, mode: str, user: str, error: str, token: str) -> str:
    self = mode == "pass" and user == current
    if mode == "add":
        title, sub = "添加账号", "新账号可以登录笔记柜，也可以在电脑和手机里填写"
        user_field = f"<label for='ac-user'>用户名<input id='ac-user' name='user' type='text' autocomplete='off' spellcheck='false' value='{e(user)}'></label>"
        old = ""
        action = "account-add"
    else:
        title = "改密码" if self else "重设密码"
        sub = user
        user_field = f"<input type='hidden' name='user' value='{e(user)}'>"
        old = (
            "<label for='ac-old'>当前密码<input id='ac-old' name='old' type='password' autocomplete='current-password'></label>"
            if self
            else ""
        )
        action = "account-pass"
    err = f"<p class='err'>{e(error)}</p>" if error else ""
    hint = "要先填对当前密码。" if self else "保存后页面不再显示密码。"
    return (
        f"<div class='top'><div><p><a class='back' href='{PREFIX}/accounts'>返回</a></p>"
        f"<h1>{title}<small>{e(sub)}</small></h1></div></div>"
        f"<form method='post' action='{PREFIX}/do'>"
        f"{hidden(token, action=action)}{user_field}{old}"
        "<label for='ac-new'>新密码<input id='ac-new' name='password' type='password' autocomplete='new-password'></label>"
        "<label for='ac-again'>再输一次<input id='ac-again' name='again' type='password' autocomplete='new-password'></label>"
        f"{err}<p class='note'>{hint}电脑和手机里已保存的密码不会跟着变。</p>"
        f"<div class='actions'><button class='go' type='submit'>{'添加' if mode == 'add' else '保存'}</button>"
        f"<a class='back' href='{PREFIX}/accounts'>取消</a></div></form>"
    )


def confirm_main(root: Path, action: str, lib: str, rel: str, stamp: str, name: str, user: str, current: str, token: str) -> str:
    if action == "trash":
        assert_note_rel(lib, rel)
        lib_root = library_dir(root, lib)
        path = child_in(lib_root, rel)
        if not path.exists() or path.resolve() == lib_root:
            raise FileNotFoundError("找不到")
        days = trash_days(lib_root)
        folder = path.is_dir()
        ask = (
            f"文件夹「{e(path.name)}」和里面的内容会一起移入「{e(lib_label(lib)[0])}」的回收站。"
            if folder
            else f"把「{e(path.name)}」移入「{e(lib_label(lib)[0])}」的回收站？"
        )
        keep = "不会自动清理。" if days <= 0 else f"默认保留 {days} 天。"
        return (
            "<h1>移入回收站</h1>"
            f"<p class='ask'>{ask}</p><p class='note'>{keep}电脑里没改过的同一篇，下次同步会进电脑上的回收站。</p>"
            f"<form class='actions' method='post' action='{PREFIX}/do'>{hidden(token, action='trash', lib=lib, p=rel)}"
            "<button class='solid' type='submit'>移入回收站</button>"
            f"<a class='back' href='{back_parent(lib, rel)}'>返回</a></form>"
        )
    if action == "restore":
        lib_root = library_dir(root, lib)
        item = trash_item(lib_root, stamp)
        dest = (lib_root / item.rel).resolve()
        clash = dest.exists()
        ask = (
            f"「{e(item.rel)}」已经存在。恢复的这份会另存，不覆盖现在的文件。"
            if clash
            else f"把「{e(item.name)}」恢复到「{e(item.rel)}」？"
        )
        label = "另存一份" if clash else "恢复"
        return (
            f"<h1>{'原位置已有同名文件' if clash else '恢复'}</h1><p class='ask'>{ask}</p>"
            f"<form class='actions' method='post' action='{PREFIX}/do'>{hidden(token, action='restore', lib=lib, stamp=item.stamp)}"
            f"<button class='go' type='submit'>{label}</button>"
            f"<a class='back' href='{qurl(PREFIX + '/trash', lib=lib)}'>返回</a></form>"
        )
    if action == "purge":
        lib_root = library_dir(root, lib)
        item = trash_item(lib_root, stamp)
        return (
            "<h1>彻底删除</h1>"
            f"<p class='ask'>彻底删除「{e(item.name)}」？此操作不能恢复。</p>"
            f"<form class='actions' method='post' action='{PREFIX}/do'>{hidden(token, action='purge', lib=lib, stamp=item.stamp)}"
            "<button class='solid' type='submit'>彻底删除</button>"
            f"<a class='back' href='{qurl(PREFIX + '/trash', lib=lib)}'>返回</a></form>"
        )
    if action == "empty":
        library_dir(root, lib)
        return (
            "<h1>清空回收站</h1>"
            f"<p class='ask'>清空「{e(lib_label(lib)[0])}」的回收站？其中的笔记和附件都会被彻底删除。</p>"
            f"<form class='actions' method='post' action='{PREFIX}/do'>{hidden(token, action='empty', lib=lib)}"
            "<button class='solid' type='submit'>清空</button>"
            f"<a class='back' href='{qurl(PREFIX + '/trash', lib=lib)}'>返回</a></form>"
        )
    if action == "loose":
        path = loose_target(root, name)
        extra = "里面的内容会一起删掉。" if path.is_dir() else ""
        return (
            "<h1>彻底删除</h1>"
            f"<p class='ask'>彻底删除根目录上的「{e(path.name)}」？它不在任何一个库里，不会进回收站。{extra}</p>"
            f"<form class='actions' method='post' action='{PREFIX}/do'>{hidden(token, action='loose', name=path.name)}"
            "<button class='solid' type='submit'>彻底删除</button>"
            f"<a class='back' href='{PREFIX}/loose'>返回</a></form>"
        )
    if action == "drop":
        err = account_drop_error(user, current, read_users())
        if err:
            return f"<h1>删除账号</h1><p class='err'>{e(err)}</p><p><a class='back' href='{PREFIX}/accounts'>返回</a></p>"
        return (
            "<h1>删除账号</h1>"
            f"<p class='ask'>删除账号「{e(user)}」？之后不能用它登录笔记柜，也不能同步。笔记还在。</p>"
            f"<form class='actions' method='post' action='{PREFIX}/do'>{hidden(token, action='account-drop', user=user)}"
            "<button class='solid' type='submit'>删除</button>"
            f"<a class='back' href='{PREFIX}/accounts'>返回</a></form>"
        )
    raise FileNotFoundError("找不到")


def back_parent(lib: str, rel: str) -> str:
    parent = str(Path(rel).parent.as_posix()) if rel else ""
    if parent == ".":
        parent = ""
    return browse(lib, parent)


class Handler(BaseHTTPRequestHandler):
    server_version = "notes-cabinet"
    user = ""

    def log_message(self, fmt: str, *args: object) -> None:
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
        self.send_header("Set-Cookie", f"cabinet={token}; Path=/files; HttpOnly; Secure; SameSite=Strict")
        self.end_headers()
        self.wfile.write(payload)

    def redirect(self, location: str) -> None:
        self.send_response(303)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def require_user(self) -> bool:
        header = self.headers.get("Authorization", "")
        user, password = "", ""
        if header.startswith("Basic "):
            import base64

            try:
                raw = base64.b64decode(header.split(" ", 1)[1]).decode("utf-8")
                user, password = raw.split(":", 1)
            except (ValueError, UnicodeDecodeError):
                user, password = "", ""
            if user and check_password(user, password):
                self.user = user
                return True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="WebDAV"')
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def wrap(self, view: str, lib: str, main: str) -> str:
        libs = shown_libraries(ROOT)
        current = lib if lib in libs else (libs[0] if libs else "")
        trash_n = 0
        if current:
            lib_root = library_dir(ROOT, current)
            days = trash_days(lib_root)
            prune_trash(lib_root, days)
            trash_n = len(trash_items(lib_root))
        return shell(self.user, libs, current, view, len(loose_entries(ROOT)), trash_n, main)

    def do_GET(self) -> None:
        if not self.require_user():
            return
        token = self.cabinet_token()
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or PREFIX
        qs = parse_qs(parsed.query)
        lib = qs.get("lib", [""])[0]
        rel = qs.get("p", [""])[0]
        try:
            if path == PREFIX and not lib and "q" not in qs:
                libs = shown_libraries(ROOT)
                if libs:
                    self.redirect(browse(libs[0]))
                    return
            if path == PREFIX:
                body = self.wrap("lib", lib, library_main(ROOT, lib, rel, qs.get("q", [""])[0]))
                title = lib_label(lib)[0] if lib in shown_libraries(ROOT) else "笔记柜"
                self.send_html(200, title, body, token)
                return
            if path == PREFIX + "/open":
                body = self.wrap("lib", lib, open_main(ROOT, lib, rel))
                self.send_html(200, rel.split("/")[-1] or "笔记", body, token)
                return
            if path == PREFIX + "/trash":
                body = self.wrap("trash", lib, trash_main(ROOT, lib))
                self.send_html(200, "回收站", body, token)
                return
            if path == PREFIX + "/loose":
                body = self.wrap("loose", lib, loose_main(ROOT))
                self.send_html(200, "未归库", body, token)
                return
            if path == PREFIX + "/accounts":
                body = self.wrap("accounts", lib, accounts_main(self.user))
                self.send_html(200, "账号", body, token)
                return
            if path == PREFIX + "/accounts/new":
                body = self.wrap("accounts", lib, account_form(self.user, "add", "", "", token))
                self.send_html(200, "添加账号", body, token)
                return
            if path == PREFIX + "/accounts/password":
                user = qs.get("user", [""])[0]
                if user not in read_users():
                    raise FileNotFoundError("没有这个账号")
                body = self.wrap("accounts", lib, account_form(self.user, "pass", user, "", token))
                self.send_html(200, "改密码", body, token)
                return
            if path == PREFIX + "/confirm":
                action = qs.get("action", [""])[0]
                main = confirm_main(
                    ROOT,
                    action,
                    lib,
                    rel,
                    qs.get("stamp", [""])[0],
                    qs.get("name", [""])[0],
                    qs.get("user", [""])[0],
                    self.user,
                    token,
                )
                view = "accounts" if action == "drop" else ("loose" if action == "loose" else ("trash" if action in {"restore", "purge", "empty"} else "lib"))
                self.send_html(200, "确认", self.wrap(view, lib, main), token)
                return
            self.send_html(404, "找不到", self.wrap("lib", lib, "<h1>找不到</h1>"), token)
        except PermissionError:
            self.send_html(400, "路径不对", self.wrap("lib", "", "<h1>路径不对</h1>"), token)
        except FileNotFoundError as err:
            self.send_html(404, "找不到", self.wrap("lib", "", f"<h1>找不到</h1><p class='note'>{e(err)}</p>"), token)
        except OSError:
            self.send_html(404, "找不到", self.wrap("lib", "", "<h1>找不到</h1>"), token)

    def do_HEAD(self) -> None:
        self.do_GET()

    def read_form(self) -> dict[str, list[str]] | None:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > 100_000:
            return None
        return parse_qs(self.rfile.read(length).decode("utf-8", errors="replace"))

    def token_ok(self, form: dict[str, list[str]], token: str) -> bool:
        cookie = ""
        for part in self.headers.get("Cookie", "").split(";"):
            key, _, value = part.strip().partition("=")
            if key == "cabinet":
                cookie = value
        given = form.get("token", [""])[0]
        return bool(cookie) and secrets.compare_digest(cookie, given) and secrets.compare_digest(cookie, token)

    def do_POST(self) -> None:
        if not self.require_user():
            return
        token = self.cabinet_token()
        parsed = urlparse(self.path)
        if parsed.path.rstrip("/") != PREFIX + "/do":
            self.send_html(404, "找不到", self.wrap("lib", "", "<h1>找不到</h1>"), token)
            return
        form = self.read_form()
        if form is None:
            self.send_html(400, "路径不对", self.wrap("lib", "", "<h1>路径不对</h1>"), token)
            return
        if not self.token_ok(form, token):
            self.send_html(400, "页面过期", self.wrap("lib", "", "<h1>页面过期</h1><p class='note'>返回后重新提交。</p>"), token)
            return
        action = form.get("action", [""])[0]
        lib = form.get("lib", [""])[0]
        try:
            self.dispatch(action, form, lib, token)
        except PermissionError:
            self.send_html(400, "路径不对", self.wrap("lib", lib, "<h1>路径不对</h1>"), token)
        except FileNotFoundError as err:
            self.send_html(404, "找不到", self.wrap("lib", lib, f"<h1>找不到</h1><p class='note'>{e(err)}</p>"), token)
        except OSError:
            self.send_html(500, "没能完成", self.wrap("lib", lib, "<h1>没能完成</h1><p class='note'>文件可能正在被占用。</p>"), token)

    def dispatch(self, action: str, form: dict[str, list[str]], lib: str, token: str) -> None:
        if action == "trash":
            rel = form.get("p", [""])[0]
            assert_note_rel(lib, rel)
            lib_root = library_dir(ROOT, lib)
            src = child_in(lib_root, rel)
            if not src.exists() or src.resolve() == lib_root:
                raise FileNotFoundError("找不到")
            parent = src.relative_to(lib_root).parent.as_posix()
            move_to_trash(lib_root, src)
            self.redirect(browse(lib, "" if parent == "." else parent))
            return
        if action == "restore":
            lib_root = library_dir(ROOT, lib)
            item = trash_item(lib_root, form.get("stamp", [""])[0])
            restore_item(lib_root, item)
            self.redirect(qurl(PREFIX + "/trash", lib=lib))
            return
        if action == "purge":
            lib_root = library_dir(ROOT, lib)
            item = trash_item(lib_root, form.get("stamp", [""])[0])
            parent = item.path.parent
            remove_tree(item.path)
            cleanup_empty(parent, lib_root)
            self.redirect(qurl(PREFIX + "/trash", lib=lib))
            return
        if action == "empty":
            lib_root = library_dir(ROOT, lib)
            trash = lib_root / TRASH
            if trash.exists():
                shutil.rmtree(trash)
            self.redirect(qurl(PREFIX + "/trash", lib=lib))
            return
        if action == "loose":
            remove_tree(loose_target(ROOT, form.get("name", [""])[0]))
            self.redirect(PREFIX + "/loose")
            return
        if action == "account-add":
            user = form.get("user", [""])[0]
            password = form.get("password", [""])[0]
            again = form.get("again", [""])[0]
            err = account_add_error(user, password, again, read_users())
            if err:
                body = self.wrap("accounts", "", account_form(self.user, "add", user, err, token))
                self.send_html(200, "添加账号", body, token)
                return
            ok, msg = save_password(user, password)
            if not ok:
                body = self.wrap("accounts", "", account_form(self.user, "add", user, "没能保存账号", token))
                self.send_html(500, "添加账号", body, token)
                return
            self.redirect(PREFIX + "/accounts")
            return
        if action == "account-pass":
            user = form.get("user", [""])[0]
            old = form.get("old", [""])[0]
            password = form.get("password", [""])[0]
            again = form.get("again", [""])[0]
            old_ok = verify_password(user, old) if user == self.user and old else False
            err = account_pass_error(user, self.user, old, password, again, read_users(), old_ok)
            if err:
                body = self.wrap("accounts", "", account_form(self.user, "pass", user, err, token))
                self.send_html(200, "改密码", body, token)
                return
            ok, _msg = save_password(user, password)
            if not ok:
                body = self.wrap("accounts", "", account_form(self.user, "pass", user, "没能保存账号", token))
                self.send_html(500, "改密码", body, token)
                return
            self.redirect(PREFIX + "/accounts")
            return
        if action == "account-drop":
            user = form.get("user", [""])[0]
            err = account_drop_error(user, self.user, read_users())
            if err:
                self.send_html(200, "删除账号", self.wrap("accounts", "", f"<h1>删除账号</h1><p class='err'>{e(err)}</p>"), token)
                return
            ok, _msg = delete_password(user)
            if not ok:
                self.send_html(500, "删除账号", self.wrap("accounts", "", "<h1>没能删除账号</h1>"), token)
                return
            self.redirect(PREFIX + "/accounts")
            return
        raise FileNotFoundError("找不到")


def check_password(user: str, password: str) -> bool:
    if not user or ":" in user or "\n" in user or "\r" in user:
        return False
    return verify_password(user, password)


def main() -> None:
    os.umask(0o022)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
