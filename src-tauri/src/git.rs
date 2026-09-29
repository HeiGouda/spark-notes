//! 调用系统已安装的 Git。HTTPS 远程的账号和密码（或访问令牌）只存在系统凭据库里；
//! 没有保存时沿用用户自己的 SSH 与凭据管理器。

use crate::secret::{delete_secret, read_secret, write_secret};
use crate::webdav::hash_bytes;
use crate::{fsops, history, vault};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, OnceLock};

const IGNORE_RULES: &[&str] = &[
    ".ttnote/cache/",
    ".ttnote/history/",
    ".ttnote/trash/",
    ".ttnote/sync/",
];
const CONFIG_EXCEPTIONS: &[&str] = &["!.ttnote/config/", "!.ttnote/config/**"];

static GIT_LOCK: Mutex<()> = Mutex::new(());
static GIT_EXE: OnceLock<Option<PathBuf>> = OnceLock::new();

const CRED_PREFIX: &str = "Spark:git:";
/// 由 Git 自带的 sh 执行，只回应 get；账号和密码经环境变量传入，不出现在命令行里
const CRED_HELPER: &str =
    "!f() { if [ \"$1\" = get ]; then printf 'username=%s\\npassword=%s\\n' \"$SPARK_GIT_USER\" \"$SPARK_GIT_PASS\"; fi; }; f";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Credentials {
    username: String,
    password: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedChange {
    pub path: String,
    pub kind: ChangeKind,
    pub letter: char,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedStatus {
    pub branch: Option<String>,
    pub detached: bool,
    pub ahead: u32,
    pub behind: u32,
    pub has_upstream: bool,
    pub changes: Vec<ParsedChange>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    pub letter: String,
    pub name: String,
    pub dir: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub installed: bool,
    pub is_repo: bool,
    pub branch: Option<String>,
    pub detached: bool,
    pub merging: bool,
    pub rebasing: bool,
    pub ahead: u32,
    pub behind: u32,
    pub has_upstream: bool,
    pub remote: Option<String>,
    pub user_name: String,
    pub user_email: String,
    /// 已保存的远程账号，没有保存时为 `None`
    pub credential_user: Option<String>,
    pub locked_reason: Option<String>,
    pub changes: Vec<GitChange>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub id: String,
    pub subject: String,
    pub time: i64,
    pub unpushed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitAction {
    pub need_identity: bool,
    /// 远程要求登录。`notice` 为空表示还没保存账号，否则是被拒绝的原因
    pub need_credentials: bool,
    /// 拉取前本地有未提交的改动，或未推送的提交删了远程还有的文件，要用户选择保留还是以仓库为准
    pub need_choice: bool,
    /// 未推送的提交里删掉的文件
    pub choice_files: Vec<String>,
    pub notice: String,
}

fn action(notice: impl Into<String>) -> GitAction {
    GitAction { need_identity: false, need_credentials: false, need_choice: false, choice_files: Vec::new(), notice: notice.into() }
}

fn need_identity() -> GitAction {
    GitAction { need_identity: true, ..action("") }
}

fn need_credentials(saved: bool) -> GitAction {
    let notice = if saved { "远程仓库拒绝了已保存的账号或密码，请重新填写" } else { "" };
    GitAction { need_credentials: true, ..action(notice) }
}

fn need_choice() -> GitAction {
    GitAction { need_choice: true, ..action("") }
}

/// 拉取前本地有未提交的改动时怎么处理
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalChanges {
    /// 返回 `need_choice`，由用户决定
    Ask,
    /// 先提交再合并
    Keep,
    /// 以仓库为准：改过的恢复成仓库版本，新建的移进回收站，删掉的恢复
    Discard,
}

fn blank_status(installed: bool) -> GitStatus {
    GitStatus {
        installed,
        is_repo: false,
        branch: None,
        detached: false,
        merging: false,
        rebasing: false,
        ahead: 0,
        behind: 0,
        has_upstream: false,
        remote: None,
        user_name: String::new(),
        user_email: String::new(),
        credential_user: None,
        locked_reason: None,
        changes: Vec::new(),
    }
}

fn with_lock<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _guard = GIT_LOCK.lock().map_err(|_| "Git 操作状态异常".to_string())?;
    f()
}

fn locate_git() -> Option<PathBuf> {
    GIT_EXE
        .get_or_init(|| {
            if command_ok("git", &["--version"]) {
                return Some(PathBuf::from("git"));
            }
            #[cfg(windows)]
            let candidates = [r"C:\Program Files\Git\cmd\git.exe", r"C:\Program Files\Git\bin\git.exe"];
            // 从访达启动时 PATH 只有 /usr/bin 等系统目录，Homebrew 装的 Git 不在其中
            #[cfg(target_os = "macos")]
            let candidates = ["/opt/homebrew/bin/git", "/usr/local/bin/git"];
            #[cfg(not(any(windows, target_os = "macos")))]
            let candidates: [&str; 0] = [];
            for candidate in candidates {
                let path = PathBuf::from(candidate);
                if path.is_file() && command_ok(candidate, &["--version"]) {
                    return Some(path);
                }
            }
            None
        })
        .clone()
}

/// Windows 上 GUI 程序启动控制台子进程会闪出黑框，需加 CREATE_NO_WINDOW
fn new_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn command_ok(program: &str, args: &[&str]) -> bool {
    new_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

struct GitOut {
    code: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl GitOut {
    fn stdout_str(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    fn stderr_str(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

fn base_command(repo: &Path, git: &Path) -> Command {
    let mut cmd = new_command(git);
    cmd.current_dir(repo)
        .arg("-c")
        .arg("core.quotepath=false")
        .arg("--no-pager")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

fn output(mut cmd: Command) -> Result<GitOut, String> {
    let Output { status, stdout, stderr } = cmd.output().map_err(|e| format!("无法运行 Git：{e}"))?;
    Ok(GitOut { code: status.code().unwrap_or(-1), stdout, stderr })
}

fn run(repo: &Path, git: &Path, args: &[&str]) -> Result<GitOut, String> {
    let mut cmd = base_command(repo, git);
    cmd.args(args);
    output(cmd)
}

/// 需要访问远程的命令。有保存的账号时只用它，不再询问系统凭据管理器；
/// 没有时仍可读取凭据管理器里已有的账号，但不让它弹出自己的登录窗口。
fn run_remote(repo: &Path, git: &Path, creds: Option<&Credentials>, args: &[&str]) -> Result<GitOut, String> {
    let mut cmd = remote_command(repo, git, creds);
    cmd.args(args);
    output(cmd)
}

fn remote_command(repo: &Path, git: &Path, creds: Option<&Credentials>) -> Command {
    let mut cmd = base_command(repo, git);
    match creds {
        Some(c) => {
            cmd.arg("-c")
                .arg("credential.helper=")
                .arg("-c")
                .arg(format!("credential.helper={CRED_HELPER}"))
                .env("SPARK_GIT_USER", &c.username)
                .env("SPARK_GIT_PASS", &c.password);
        }
        None => {
            cmd.arg("-c").arg("credential.interactive=never");
        }
    }
    cmd
}

fn is_http_remote(url: &str) -> bool {
    let url = url.trim().to_ascii_lowercase();
    url.starts_with("https://") || url.starts_with("http://")
}

fn auth_failed(stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    [
        "authentication failed",
        "could not read username",
        "could not read password",
        "unable to get password",
        "user interactivity has been disabled",
        "invalid username or password",
        "http basic: access denied",
        "returned error: 401",
        "returned error: 403",
        "鉴权失败",
        "认证失败",
        "身份验证失败",
        "无法读取用户名",
        "无法读取密码",
    ]
    .iter()
    .any(|k| text.contains(k))
}

fn rejected(stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    ["[rejected]", "non-fast-forward", "fetch first", "拒绝"].iter().any(|k| text.contains(k))
}

fn credential_account(root: &Path) -> String {
    format!("{CRED_PREFIX}{}", hash_bytes(root.to_string_lossy().as_bytes()))
}

fn load_credentials(root: &Path) -> Result<Option<Credentials>, String> {
    let Some(raw) = read_secret(&credential_account(root))? else {
        return Ok(None);
    };
    Ok(serde_json::from_str::<Credentials>(&raw)
        .ok()
        .filter(|c| !c.username.is_empty() && !c.password.is_empty()))
}

/// 用户名为空时删除已保存的账号；密码为空时沿用已保存的密码。
pub fn set_credentials(root: &Path, username: &str, password: &str) -> Result<(), String> {
    let account = credential_account(root);
    let username = username.trim();
    if username.is_empty() {
        return delete_secret(&account);
    }
    if username.chars().any(char::is_control) || password.chars().any(char::is_control) {
        return Err("账号或密码包含无效字符".into());
    }
    let password = if password.is_empty() {
        load_credentials(root)?.map(|c| c.password).ok_or_else(|| "请填写密码或访问令牌".to_string())?
    } else {
        password.to_string()
    };
    let raw = serde_json::to_string(&Credentials { username: username.into(), password })
        .map_err(|e| format!("保存账号失败：{e}"))?;
    write_secret(&account, &raw).map_err(|e| e.replace("密码", "Git 账号"))
}

/// 远程失败时的结果：认证问题转成弹窗，其余给出原因。
fn remote_failure(remote: &str, creds: Option<&Credentials>, out: &GitOut) -> Result<GitAction, String> {
    let stderr = out.stderr_str();
    if is_http_remote(remote) && auth_failed(&stderr) {
        return Ok(need_credentials(creds.is_some()));
    }
    if !is_http_remote(remote) && stderr.contains("Permission denied (publickey)") {
        return Err("SSH 密钥认证失败。请确认这台电脑的 SSH 密钥已添加到远程仓库，或改用 HTTPS 地址并填写账号".into());
    }
    Err(git_error(&stderr, &out.stdout_str()))
}

fn run_ok(repo: &Path, git: &Path, args: &[&str]) -> Result<String, String> {
    let out = run(repo, git, args)?;
    if out.code != 0 {
        return Err(git_error(&out.stderr_str(), &out.stdout_str()));
    }
    Ok(out.stdout_str())
}

fn git_error(stderr: &str, stdout: &str) -> String {
    let text = format!("{stderr}\n{stdout}");
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let tail: Vec<&str> = if lines.len() > 6 { lines[lines.len() - 6..].to_vec() } else { lines };
    let joined = tail
        .join(" ")
        .replace("fatal: ", "")
        .replace("error: ", "");
    if joined.trim().is_empty() { "Git 命令失败".into() } else { joined }
}

fn require_git() -> Result<PathBuf, String> {
    locate_git().ok_or_else(|| "未检测到 Git。请安装 Git for Windows 后重新打开。".into())
}

fn same_path(a: &Path, b: &Path) -> bool {
    fn key(p: &Path) -> String {
        let canon = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        canon
            .to_string_lossy()
            .replace('/', "\\")
            .trim_start_matches(r"\\?\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    }
    key(a) == key(b)
}

/// 笔记库目录本身是仓库根。位于其他仓库的子目录里时不算，避免把外层仓库的提交做进笔记库。
fn is_repo(root: &Path, git: &Path) -> Result<bool, String> {
    if !root.is_dir() {
        return Err(format!("笔记库目录不存在：{}", root.display()));
    }
    let out = run(root, git, &["rev-parse", "--is-inside-work-tree"])?;
    if out.code != 0 || out.stdout_str().trim() != "true" {
        return Ok(false);
    }
    let top = run_ok(root, git, &["rev-parse", "--show-toplevel"])?;
    Ok(same_path(Path::new(top.trim()), root))
}

fn git_dir(root: &Path, git: &Path) -> Result<PathBuf, String> {
    let raw = run_ok(root, git, &["rev-parse", "--git-dir"])?;
    let p = PathBuf::from(raw.trim());
    Ok(if p.is_absolute() { p } else { root.join(p) })
}

/// 在已有 `.gitignore` 末尾补上缺少的规则，保留原来的内容和换行符。
pub fn merge_gitignore(existing: &str) -> String {
    let crlf = existing.contains("\r\n");
    let nl = if crlf { "\r\n" } else { "\n" };
    let have: HashSet<&str> = existing.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    let mut out = existing.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push_str(nl);
    }
    for rule in IGNORE_RULES {
        if !have.contains(rule) {
            out.push_str(rule);
            out.push_str(nl);
        }
    }
    let broad = have.iter().any(|l| matches!(*l, ".ttnote" | ".ttnote/" | ".ttnote/*" | ".ttnote/**"));
    if broad {
        for rule in CONFIG_EXCEPTIONS {
            if !have.contains(rule) && !out.lines().any(|l| l.trim() == *rule) {
                out.push_str(rule);
                out.push_str(nl);
            }
        }
    }
    out
}

fn ensure_gitignore(root: &Path) -> Result<(), String> {
    let path = root.join(".gitignore");
    let existing = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("读取 .gitignore 失败：{e}")),
    };
    let merged = merge_gitignore(&existing);
    if merged != existing {
        vault::atomic_write(&path, &merged)?;
    }
    Ok(())
}

fn is_note_path(path: &str) -> bool {
    Path::new(path).extension().is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

fn stem_of(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn path_without_md(path: &str) -> String {
    let p = Path::new(path);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    match p.parent().map(|d| d.to_string_lossy().replace('\\', "/")) {
        Some(dir) if !dir.is_empty() => format!("{dir}/{stem}"),
        _ => stem,
    }
}

fn format_group(label: &str, paths: &[String]) -> String {
    let stems: Vec<String> = paths.iter().map(|p| stem_of(p)).collect();
    let names: Vec<String> = paths
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let dup = stems.iter().filter(|s| *s == &stems[i]).count() > 1;
            if dup { path_without_md(p) } else { stems[i].clone() }
        })
        .collect();
    let shown = if names.len() > 3 {
        format!("{}、{}、{}等", names[0], names[1], names[2])
    } else {
        names.join("、")
    };
    format!("{label} {} 篇（{shown}）", names.len())
}

/// `prefix` 为「自动提交」或「拉取前自动提交」。只点名 `.md`，其余文件另计。
pub fn auto_commit_message(prefix: &str, changes: &[ParsedChange]) -> String {
    let mut parts = Vec::new();
    for (kind, label) in [(ChangeKind::Added, "新增"), (ChangeKind::Modified, "修改"), (ChangeKind::Deleted, "删除")] {
        let paths: Vec<String> = changes
            .iter()
            .filter(|c| c.kind == kind && is_note_path(&c.path))
            .map(|c| c.path.clone())
            .collect();
        if !paths.is_empty() {
            parts.push(format_group(label, &paths));
        }
    }
    let others = changes.iter().filter(|c| !is_note_path(&c.path)).count();
    if parts.is_empty() {
        return format!("{prefix}：其他文件 {others} 个");
    }
    let mut body = parts.join("、");
    if others > 0 {
        body = format!("{body}，以及其他 {others} 个文件");
    }
    format!("{prefix}：{body}")
}

/// 冲突副本的相对路径。`seq <= 1` 不加序号，从 2 起写成 ` 2`。
pub fn conflict_rel(path: &str, computer: &str, stamp: &str, seq: u32) -> String {
    let slash = path.replace('\\', "/");
    let p = Path::new(&slash);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "笔记".into());
    let parent = p.parent().map(|d| d.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    let suffix = if seq <= 1 { String::new() } else { format!(" {seq}") };
    let file = format!("{stem} (冲突 {computer} {stamp}){suffix}.md");
    if parent.is_empty() { file } else { format!("{parent}/{file}") }
}

fn xy_bytes(field: &str) -> (u8, u8) {
    let b = field.as_bytes();
    let map = |c: u8| if c == b'.' { b' ' } else { c };
    (b.first().copied().map(map).unwrap_or(b' '), b.get(1).copied().map(map).unwrap_or(b' '))
}

fn classify(x: u8, y: u8) -> (ChangeKind, char) {
    let renamed = x == b'R' || y == b'R' || x == b'C' || y == b'C';
    if x == b'?' || y == b'?' || x == b'A' || y == b'A' {
        if x == b'D' || y == b'D' {
            return (ChangeKind::Deleted, 'D');
        }
        return (ChangeKind::Added, 'A');
    }
    if renamed {
        return (ChangeKind::Modified, 'M');
    }
    if x == b'D' || y == b'D' {
        return (ChangeKind::Deleted, 'D');
    }
    (ChangeKind::Modified, 'M')
}

fn rest_after(line: &str, n_prefix: usize) -> Option<&str> {
    let mut rest = line;
    for _ in 0..n_prefix {
        let (_, tail) = rest.split_once(' ')?;
        rest = tail;
    }
    Some(rest)
}

/// 解析 `git status --porcelain=v2 -z`。重命名时下一条记录是原路径。
pub fn parse_status_v2(raw: &str) -> ParsedStatus {
    let fields: Vec<&str> = raw.split('\0').map(|s| s.trim_end_matches('\r')).filter(|s| !s.is_empty()).collect();
    let mut parsed = ParsedStatus::default();
    let mut i = 0;
    while i < fields.len() {
        let line = fields[i];
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            parsed.detached = rest == "(detached)";
            parsed.branch = if parsed.detached { None } else { Some(rest.to_string()) };
            i += 1;
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    parsed.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    parsed.behind = n.parse().unwrap_or(0);
                }
            }
            i += 1;
            continue;
        }
        if line.starts_with("# branch.upstream ") {
            parsed.has_upstream = true;
            i += 1;
            continue;
        }
        if line.starts_with('#') {
            i += 1;
            continue;
        }
        if let Some(path) = line.strip_prefix("? ").or_else(|| line.strip_prefix("! ")) {
            if line.starts_with("? ") {
                parsed.changes.push(ParsedChange {
                    path: path.replace('\\', "/"),
                    kind: ChangeKind::Added,
                    letter: 'A',
                });
            }
            i += 1;
            continue;
        }
        let (kind_tag, n_prefix) = if line.starts_with("1 ") {
            ("1", 8)
        } else if line.starts_with("2 ") {
            ("2", 9)
        } else if line.starts_with("u ") {
            ("u", 10)
        } else {
            i += 1;
            continue;
        };
        let Some(path) = rest_after(line, n_prefix) else {
            i += 1;
            continue;
        };
        let xy = line.split_whitespace().nth(1).unwrap_or("..");
        let (x, y) = xy_bytes(xy);
        let (kind, letter) = classify(x, y);
        let path = path.replace('\\', "/");
        if kind_tag == "2" {
            i += 2;
        } else {
            i += 1;
        }
        parsed.changes.push(ParsedChange { path, kind, letter });
    }
    parsed
}

fn display_change(change: &ParsedChange) -> GitChange {
    let slash = change.path.replace('\\', "/");
    let (dir, file) = match slash.rfind('/') {
        Some(i) => (slash[..i].to_string(), slash[i + 1..].to_string()),
        None => (String::new(), slash.clone()),
    };
    let name = if is_note_path(&file) { stem_of(&file) } else { file };
    GitChange { path: slash, letter: change.letter.to_string(), name, dir }
}

fn read_parsed(root: &Path, git: &Path) -> Result<ParsedStatus, String> {
    let out = run(root, git, &["status", "--porcelain=v2", "-z", "-b", "-uall"])?;
    if out.code != 0 {
        return Err(git_error(&out.stderr_str(), &out.stdout_str()));
    }
    Ok(parse_status_v2(&out.stdout_str()))
}

fn lock_reason(detached: bool, merging: bool, rebasing: bool) -> Option<String> {
    if rebasing {
        Some("正在变基，提交、拉取和推送已暂停。请用外部 Git 工具完成或中止变基后再回到这里。".into())
    } else if merging {
        Some("正在合并，提交、拉取和推送已暂停。请用外部 Git 工具完成或中止合并后再回到这里。".into())
    } else if detached {
        Some("当前处于分离 HEAD，提交、拉取和推送已暂停。请用外部 Git 工具回到分支后再来。".into())
    } else {
        None
    }
}

fn flags(root: &Path, git: &Path) -> Result<(bool, bool), String> {
    let dir = git_dir(root, git)?;
    let merging = dir.join("MERGE_HEAD").is_file();
    let rebasing = dir.join("rebase-merge").is_dir() || dir.join("rebase-apply").is_dir();
    Ok((merging, rebasing))
}

fn config_get(root: &Path, git: &Path, key: &str) -> String {
    run(root, git, &["config", "--get", key])
        .ok()
        .filter(|o| o.code == 0)
        .map(|o| o.stdout_str().trim().to_string())
        .unwrap_or_default()
}

fn has_identity(root: &Path, git: &Path) -> bool {
    !config_get(root, git, "user.name").trim().is_empty() && !config_get(root, git, "user.email").trim().is_empty()
}

fn remote_host(url: &str) -> Option<String> {
    let url = url.trim();
    let rest = match url.find("://") {
        Some(i) => &url[i + 3..],
        // git@github.com:用户/仓库.git
        None => url.split_once(':').map(|(h, _)| h)?,
    };
    let host = rest.split(['/', ':']).next()?.rsplit('@').next()?.to_ascii_lowercase();
    if host.is_empty() { None } else { Some(host) }
}

/// 自动生成的提交身份：用户名取远程账号或系统用户名，邮箱用不会收信的地址
pub fn auto_identity(account: Option<&str>, remote: Option<&str>, os_user: &str) -> (String, String) {
    let name = account.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(os_user.trim());
    let name = if name.is_empty() { "Spark" } else { name };
    let local: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')).collect();
    let local = if local.is_empty() { "spark".to_string() } else { local };
    let email = match remote.and_then(remote_host) {
        Some(host) if host == "github.com" => format!("{local}@users.noreply.github.com"),
        Some(host) => format!("{local}@users.noreply.{host}"),
        None => format!("{local}@spark.local"),
    };
    (name.to_string(), email)
}

/// 没有提交身份时自动补上，只写入本仓库，不改全局配置
fn ensure_identity(root: &Path, git: &Path) -> bool {
    if has_identity(root, git) {
        return true;
    }
    let account = load_credentials(root).ok().flatten().map(|c| c.username);
    let os_user = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default();
    let (name, email) = auto_identity(account.as_deref(), remote_of(root, git).as_deref(), &os_user);
    if config_get(root, git, "user.name").trim().is_empty() {
        let _ = run(root, git, &["config", "--local", "user.name", &name]);
    }
    if config_get(root, git, "user.email").trim().is_empty() {
        let _ = run(root, git, &["config", "--local", "user.email", &email]);
    }
    has_identity(root, git)
}

fn remote_of(root: &Path, git: &Path) -> Option<String> {
    let out = run(root, git, &["remote", "get-url", "origin"]).ok()?;
    if out.code != 0 {
        return None;
    }
    let url = out.stdout_str();
    let url = url.trim();
    if url.is_empty() { None } else { Some(url.to_string()) }
}

fn branch_of(status: &GitStatus) -> Result<String, String> {
    status.branch.clone().filter(|b| !b.is_empty()).ok_or_else(|| "当前不在分支上".into())
}

fn has_head(root: &Path, git: &Path) -> Result<bool, String> {
    Ok(run(root, git, &["rev-parse", "--verify", "--quiet", "HEAD"])?.code == 0)
}

fn read_status(root: &Path, git: &Path) -> Result<GitStatus, String> {
    if !root.is_dir() {
        return Err(format!("笔记库目录不存在：{}", root.display()));
    }
    if !is_repo(root, git)? {
        return Ok(blank_status(true));
    }
    ensure_gitignore(root)?;
    let parsed = read_parsed(root, git)?;
    let (merging, rebasing) = flags(root, git)?;
    let (user_name, user_email) = (config_get(root, git, "user.name"), config_get(root, git, "user.email"));
    Ok(GitStatus {
        installed: true,
        is_repo: true,
        branch: parsed.branch.clone(),
        detached: parsed.detached,
        merging,
        rebasing,
        ahead: parsed.ahead,
        behind: parsed.behind,
        has_upstream: parsed.has_upstream,
        remote: remote_of(root, git),
        user_name,
        user_email,
        credential_user: load_credentials(root).ok().flatten().map(|c| c.username),
        locked_reason: lock_reason(parsed.detached, merging, rebasing),
        changes: parsed.changes.iter().map(display_change).collect(),
    })
}

fn ensure_operable(status: &GitStatus) -> Result<(), String> {
    if !status.installed {
        return Err("未检测到 Git。请安装 Git for Windows 后重新打开。".into());
    }
    if !status.is_repo {
        return Err("请先初始化仓库".into());
    }
    if let Some(reason) = &status.locked_reason {
        return Err(reason.clone());
    }
    Ok(())
}

fn commit_all(root: &Path, git: &Path, message: &str) -> Result<(), String> {
    run_ok(root, git, &["add", "-A"])?;
    let out = run(root, git, &["commit", "-m", message])?;
    if out.code != 0 {
        let blob = format!("{}{}", out.stderr_str(), out.stdout_str());
        if blob.contains("nothing to commit") || blob.contains("无文件要提交") || blob.contains("干净的工作区") {
            return Ok(());
        }
        return Err(git_error(&out.stderr_str(), &out.stdout_str()));
    }
    Ok(())
}

fn parsed_of(status: &GitStatus) -> Vec<ParsedChange> {
    status
        .changes
        .iter()
        .map(|c| ParsedChange {
            path: c.path.clone(),
            kind: match c.letter.as_str() {
                "A" => ChangeKind::Added,
                "D" => ChangeKind::Deleted,
                _ => ChangeKind::Modified,
            },
            letter: c.letter.chars().next().unwrap_or('M'),
        })
        .collect()
}

pub fn status(root: &Path) -> Result<GitStatus, String> {
    with_lock(|| match locate_git() {
        None => Ok(blank_status(false)),
        Some(git) => read_status(root, &git),
    })
}

pub fn init_repo(root: &Path) -> Result<(), String> {
    with_lock(|| {
        let git = require_git()?;
        init_locked(root, &git)
    })
}

fn init_locked(root: &Path, git: &Path) -> Result<(), String> {
    if !root.is_dir() {
        return Err(format!("笔记库目录不存在：{}", root.display()));
    }
    if !is_repo(root, git)? {
        run_ok(root, git, &["init"])?;
    }
    ensure_gitignore(root)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemoteRefs {
    /// 远程默认分支
    pub head: Option<String>,
    pub branches: Vec<String>,
}

/// 解析 `git ls-remote --symref origin`
pub fn parse_ls_remote(out: &str) -> RemoteRefs {
    let mut refs = RemoteRefs::default();
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("ref: ") {
            if let Some((target, "HEAD")) = rest.split_once('\t') {
                refs.head = target.strip_prefix("refs/heads/").map(String::from);
            }
        } else if let Some(branch) = line.split_once('\t').and_then(|(_, r)| r.strip_prefix("refs/heads/")) {
            refs.branches.push(branch.to_string());
        }
    }
    if refs.head.is_none() && refs.branches.len() == 1 {
        refs.head = refs.branches.first().cloned();
    }
    refs
}

/// 本地分支还没关联远程、远程也没有同名分支时，改成远程默认分支的名字。
/// 否则拉取时找不到对应分支，远程的笔记拉不下来，推送又会在远程多出一个分支。
fn align_branch(root: &Path, git: &Path, refs: &RemoteRefs) -> Result<(), String> {
    let Some(head) = refs.head.as_deref() else { return Ok(()) };
    let parsed = read_parsed(root, git)?;
    let Some(local) = parsed.branch.as_deref() else { return Ok(()) };
    if parsed.has_upstream || local == head || refs.branches.iter().any(|b| b == local) {
        return Ok(());
    }
    if has_head(root, git)? {
        run_ok(root, git, &["branch", "-m", head])?;
    } else {
        run_ok(root, git, &["symbolic-ref", "HEAD", &format!("refs/heads/{head}")])?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    /// 远程要求登录。`rejected` 表示已保存的账号被拒绝
    pub need_login: bool,
    pub rejected: bool,
    pub remote_empty: bool,
    pub local_commits: bool,
}

/// 填好远程地址后点“连接”：需要时初始化仓库，设置 origin，实际访问一次远程，
/// 对齐分支名，并自动补上提交身份。账号为空时沿用已保存的。
pub fn connect(root: &Path, url: &str, username: &str, password: &str) -> Result<ConnectResult, String> {
    with_lock(|| {
        let git = require_git()?;
        let url = url.trim();
        if url.is_empty() {
            return Err("请填写远程仓库地址".into());
        }
        init_locked(root, &git)?;
        set_remote_locked(root, &git, url)?;
        if !username.trim().is_empty() {
            set_credentials(root, username, password)?;
        }
        let creds = load_credentials(root)?;
        let out = run_remote(root, &git, creds.as_ref(), &["ls-remote", "--symref", "origin"])?;
        if out.code != 0 {
            remote_failure(url, creds.as_ref(), &out)?;
            return Ok(ConnectResult { need_login: true, rejected: creds.is_some(), remote_empty: false, local_commits: false });
        }
        let refs = parse_ls_remote(&out.stdout_str());
        align_branch(root, &git, &refs)?;
        ensure_identity(root, &git);
        Ok(ConnectResult { need_login: false, rejected: false, remote_empty: refs.branches.is_empty(), local_commits: has_head(root, &git)? })
    })
}

pub fn set_identity(root: &Path, name: &str, email: &str) -> Result<(), String> {
    with_lock(|| {
        let git = require_git()?;
        if !is_repo(root, &git)? {
            return Err("请先初始化仓库".into());
        }
        let name = name.trim();
        let email = email.trim();
        if name.is_empty() || email.is_empty() {
            return Err("请填写用户名和邮箱".into());
        }
        if name.chars().any(char::is_control) || email.chars().any(|c| c.is_control() || c.is_whitespace()) || !email.contains('@') {
            return Err("用户名或邮箱无效".into());
        }
        run_ok(root, &git, &["config", "--local", "user.name", name])?;
        run_ok(root, &git, &["config", "--local", "user.email", email])?;
        Ok(())
    })
}

pub fn set_remote(root: &Path, url: &str) -> Result<(), String> {
    with_lock(|| {
        let git = require_git()?;
        set_remote_locked(root, &git, url)
    })
}

fn set_remote_locked(root: &Path, git: &Path, url: &str) -> Result<(), String> {
    if !is_repo(root, git)? {
        return Err("请先初始化仓库".into());
    }
    let url = url.trim();
    if url.chars().any(char::is_control) {
        return Err("远程地址无效".into());
    }
    let current = remote_of(root, git);
    if url.is_empty() {
        if current.is_some() {
            run_ok(root, git, &["remote", "remove", "origin"])?;
        }
        return Ok(());
    }
    match current.as_deref() {
        Some(u) if u == url => {}
        Some(_) => {
            run_ok(root, git, &["remote", "set-url", "origin", url])?;
        }
        None => {
            run_ok(root, git, &["remote", "add", "origin", url])?;
        }
    }
    Ok(())
}

fn commit_locked(root: &Path, git: &Path, message: &str) -> Result<GitAction, String> {
    let snapshot = read_status(root, git)?;
    ensure_operable(&snapshot)?;
    let message = message.trim();
    if message.is_empty() {
        return Err("请填写提交说明".into());
    }
    if snapshot.changes.is_empty() {
        return Ok(action("没有需要提交的改动"));
    }
    if !ensure_identity(root, git) {
        return Ok(need_identity());
    }
    commit_all(root, git, message)?;
    Ok(action("已提交"))
}

pub fn commit(root: &Path, message: &str) -> Result<GitAction, String> {
    with_lock(|| {
        let git = require_git()?;
        commit_locked(root, &git, message)
    })
}

pub fn auto_commit(root: &Path, prefix: &str) -> Result<GitAction, String> {
    if prefix != "自动提交" && prefix != "拉取前自动提交" {
        return Err("无效的自动提交".into());
    }
    with_lock(|| {
        let Some(git) = locate_git() else {
            return Ok(action(""));
        };
        if !is_repo(root, &git)? {
            return Ok(action(""));
        }
        let snapshot = read_status(root, &git)?;
        if snapshot.locked_reason.is_some() || snapshot.changes.is_empty() {
            return Ok(action(""));
        }
        if !ensure_identity(root, &git) {
            return Ok(need_identity());
        }
        let message = auto_commit_message(prefix, &parsed_of(&snapshot));
        commit_all(root, &git, &message)?;
        Ok(action(message))
    })
}

/// macOS 的 GUI 程序没有 HOSTNAME 环境变量，读系统设置里的电脑名称
#[cfg(target_os = "macos")]
fn system_computer_name() -> Option<String> {
    let out = new_command("scutil").args(["--get", "ComputerName"]).stdin(Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(not(target_os = "macos"))]
fn system_computer_name() -> Option<String> {
    None
}

fn computer_name() -> String {
    let raw = std::env::var("COMPUTERNAME")
        .ok()
        .or_else(system_computer_name)
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "这台电脑".into());
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() { "这台电脑".into() } else { cleaned }
}

fn local_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H%M").to_string()
}

fn stage_blob(root: &Path, git: &Path, stage: u8, path: &str) -> Result<Option<Vec<u8>>, String> {
    let spec = format!(":{stage}:{path}");
    let out = run(root, git, &["cat-file", "-p", &spec])?;
    if out.code != 0 {
        return Ok(None);
    }
    Ok(Some(out.stdout))
}

fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建目录失败 {}：{e}", dir.display()))?;
    }
    vault::atomic_write_bytes(path, bytes)
}

fn unmerged_paths(root: &Path, git: &Path) -> Result<Vec<String>, String> {
    let out = run(root, git, &["diff", "--name-only", "-z", "--diff-filter=U"])?;
    if out.code != 0 {
        return Err(git_error(&out.stderr_str(), &out.stdout_str()));
    }
    Ok(out
        .stdout_str()
        .split('\0')
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty())
        .collect())
}

fn resolve_notes(root: &Path, git: &Path, notes: &[String]) -> Result<usize, String> {
    let computer = computer_name();
    let stamp = local_stamp();
    let mut copies = 0usize;
    for path in notes {
        let ours = stage_blob(root, git, 2, path)?;
        let theirs = stage_blob(root, git, 3, path)?;
        match (ours, theirs) {
            (Some(local), Some(remote)) => {
                let dest = vault::resolve(root, path)?;
                write_bytes(&dest, &remote)?;
                let rel = unique_conflict_rel(root, path, &computer, &stamp)?;
                write_bytes(&vault::resolve(root, &rel)?, &local)?;
                run_ok(root, git, &["add", "--", path, &rel])?;
                copies += 1;
            }
            (Some(local), None) => {
                let dest = vault::resolve(root, path)?;
                if dest.exists() {
                    fs::remove_file(&dest).map_err(|e| format!("删除 {} 失败：{e}", path))?;
                }
                run_ok(root, git, &["rm", "-f", "--ignore-unmatch", "--", path])?;
                let rel = unique_conflict_rel(root, path, &computer, &stamp)?;
                write_bytes(&vault::resolve(root, &rel)?, &local)?;
                run_ok(root, git, &["add", "--", &rel])?;
                copies += 1;
            }
            (None, Some(remote)) => {
                write_bytes(&vault::resolve(root, path)?, &remote)?;
                run_ok(root, git, &["add", "--", path])?;
            }
            (None, None) => {
                run_ok(root, git, &["rm", "-f", "--ignore-unmatch", "--", path])?;
            }
        }
    }
    Ok(copies)
}

fn unique_conflict_rel(root: &Path, path: &str, computer: &str, stamp: &str) -> Result<String, String> {
    for seq in 1..100 {
        let rel = conflict_rel(path, computer, stamp, seq);
        if !vault::resolve(root, &rel)?.exists() {
            return Ok(rel);
        }
    }
    Err("无法生成冲突副本文件名".into())
}

fn finish_conflicts(root: &Path, git: &Path) -> Result<GitAction, String> {
    let paths = unmerged_paths(root, git)?;
    let mut notes = Vec::new();
    let mut others = Vec::new();
    for path in paths {
        if is_note_path(&path) {
            notes.push(path);
        } else {
            others.push(path);
        }
    }
    if !others.is_empty() {
        let _ = run(root, git, &["merge", "--abort"]);
        let shown = if others.len() > 5 {
            format!("{}等", others.iter().take(5).cloned().collect::<Vec<_>>().join("、"))
        } else {
            others.join("、")
        };
        return Err(format!("图片等文件发生冲突，已中止合并。请用外部 Git 工具处理：{shown}"));
    }
    if !ensure_identity(root, git) {
        let _ = run(root, git, &["merge", "--abort"]);
        return Ok(need_identity());
    }
    let copies = resolve_notes(root, git, &notes).inspect_err(|_| {
        let _ = run(root, git, &["merge", "--abort"]);
    })?;
    let message = if copies == 0 {
        "合并远程".into()
    } else {
        format!("合并远程：{copies} 篇笔记冲突，已保留两份")
    };
    commit_all(root, git, &message)?;
    if copies == 0 {
        Ok(action("已拉取"))
    } else {
        Ok(action(format!("有 {copies} 篇笔记冲突，已保留两份，请打开冲突副本手动合并")))
    }
}

fn pull_notice(stdout: &str) -> String {
    if stdout.contains("Already up to date") || stdout.contains("已经是最新") {
        "已是最新".into()
    } else {
        "已拉取".into()
    }
}

const NO_REMOTE_BRANCH: &str = "远程还没有这个分支，无需拉取";

/// 放弃未提交的改动，回到最近一次提交。放弃的内容都能找回：
/// 改过的笔记先存历史版本，改过的附件和新建的文件移进回收站；`.ttnote/` 下的配置直接还原。
fn discard_changes(root: &Path, git: &Path) -> Result<(), String> {
    let head = has_head(root, git)?;
    if head {
        run_ok(root, git, &["reset", "-q"])?;
    } else {
        let _ = run(root, git, &["rm", "-r", "-q", "--cached", "--ignore-unmatch", "."]);
    }
    let mut restore: Vec<String> = Vec::new();
    for change in read_parsed(root, git)?.changes {
        let path = change.path;
        match change.kind {
            ChangeKind::Added => fsops::trash_entry(root, &path)?,
            ChangeKind::Modified if path.starts_with(".ttnote/") => restore.push(path),
            ChangeKind::Modified => {
                if is_note_path(&path) {
                    history::snapshot_now(root, &path)?;
                } else {
                    fsops::trash_entry(root, &path)?;
                }
                restore.push(path);
            }
            ChangeKind::Deleted => restore.push(path),
        }
    }
    if head && !restore.is_empty() {
        let mut args = vec!["checkout", "HEAD", "--"];
        args.extend(restore.iter().map(String::as_str));
        run_ok(root, git, &args)?;
    }
    Ok(())
}

/// 以仓库为准时，本地还没推送的提交也要撤销，回到远程分支。撤销前备份这些提交带来的差异：
/// 远程没有的文件移进回收站，改过的笔记存历史版本、改过的附件移进回收站；删掉的由 reset 恢复。
fn reset_to_remote(root: &Path, git: &Path, tracking: &str) -> Result<(), String> {
    let ahead = run_ok(root, git, &["rev-list", "--count", &format!("{tracking}..HEAD")])?;
    if ahead.trim() == "0" {
        return Ok(());
    }
    let diff = run_ok(root, git, &["diff", "--name-status", "--no-renames", "-z", tracking, "HEAD"])?;
    let fields: Vec<&str> = diff.split('\0').filter(|s| !s.is_empty()).collect();
    for pair in fields.chunks(2) {
        let [status, path] = pair else { continue };
        let path = path.replace('\\', "/");
        let exists = vault::resolve(root, &path)?.exists();
        match status.chars().next() {
            Some('A') if exists => fsops::trash_entry(root, &path)?,
            Some('M') if exists && !path.starts_with(".ttnote/") => {
                if is_note_path(&path) {
                    history::snapshot_now(root, &path)?;
                } else {
                    fsops::trash_entry(root, &path)?;
                }
            }
            _ => {}
        }
    }
    run_ok(root, git, &["reset", "-q", "--hard", tracking])?;
    Ok(())
}

fn pull_locked(root: &Path, git: &Path, creds: Option<&Credentials>, local: LocalChanges) -> Result<GitAction, String> {
    let snapshot = read_status(root, git)?;
    ensure_operable(&snapshot)?;
    let Some(remote) = snapshot.remote.clone() else {
        return Err("还没有远程仓库，请先在 Git 设置里填写地址".into());
    };
    let branch = branch_of(&snapshot)?;
    if !snapshot.changes.is_empty() {
        match local {
            LocalChanges::Ask => return Ok(need_choice()),
            LocalChanges::Keep => {
                if !ensure_identity(root, git) {
                    return Ok(need_identity());
                }
                let message = auto_commit_message("拉取前自动提交", &parsed_of(&snapshot));
                commit_all(root, git, &message)?;
            }
            LocalChanges::Discard => discard_changes(root, git)?,
        }
    }
    let fetched = run_remote(root, git, creds, &["fetch", "origin"])?;
    if fetched.code != 0 {
        return remote_failure(&remote, creds, &fetched);
    }
    // 首次拉取时远程可能是空仓库，或只有网页上建仓库时生成的 README
    let tracking = if snapshot.has_upstream { "@{upstream}".to_string() } else { format!("refs/remotes/origin/{branch}") };
    if run(root, git, &["rev-parse", "--verify", "--quiet", &tracking])?.code != 0 {
        return Ok(action(NO_REMOTE_BRANCH));
    }
    if has_head(root, git)? {
        match local {
            LocalChanges::Ask => {
                let deleted = unpushed_deletions(root, git, &tracking)?;
                if !deleted.is_empty() {
                    return Ok(GitAction { choice_files: deleted, ..need_choice() });
                }
            }
            LocalChanges::Discard => reset_to_remote(root, git, &tracking)?,
            LocalChanges::Keep => {}
        }
    }
    let mut args = vec!["merge", "--no-edit"];
    if !snapshot.has_upstream {
        args.push("--allow-unrelated-histories");
    }
    args.push(&tracking);
    let out = run(root, git, &args)?;
    finish_pull(root, git, &remote, creds, &out)
}

/// 本地还没推送的提交里删掉、而远程仍然有的文件。合并后它们会被删掉，推送后远程也会删掉，所以要先问
fn unpushed_deletions(root: &Path, git: &Path, tracking: &str) -> Result<Vec<String>, String> {
    let out = run_ok(root, git, &["diff", "--name-only", "--no-renames", "--diff-filter=D", "-z", &format!("{tracking}...HEAD")])?;
    Ok(out.split('\0').map(|s| s.trim().replace('\\', "/")).filter(|s| !s.is_empty()).collect())
}

fn finish_pull(root: &Path, git: &Path, remote: &str, creds: Option<&Credentials>, out: &GitOut) -> Result<GitAction, String> {
    if out.code == 0 {
        return Ok(action(pull_notice(&out.stdout_str())));
    }
    let (merging, _) = flags(root, git)?;
    if merging {
        return finish_conflicts(root, git);
    }
    remote_failure(remote, creds, out)
}

fn push_notice(stdout: &str, stderr: &str) -> String {
    let blob = format!("{stdout}\n{stderr}");
    if blob.contains("Everything up-to-date") || blob.contains("一切皆为最新") {
        "没有需要推送的提交".into()
    } else {
        "已推送".into()
    }
}

fn push_locked(root: &Path, git: &Path, creds: Option<&Credentials>) -> Result<GitAction, String> {
    let snapshot = read_status(root, git)?;
    ensure_operable(&snapshot)?;
    let Some(remote) = snapshot.remote.clone() else {
        return Err("还没有远程仓库，请先在 Git 设置里填写地址".into());
    };
    if !has_head(root, git)? {
        return Ok(action("没有需要推送的提交"));
    }
    let out = if snapshot.has_upstream {
        run_remote(root, git, creds, &["push"])?
    } else {
        let branch = branch_of(&snapshot)?;
        run_remote(root, git, creds, &["push", "-u", "origin", &branch])?
    };
    if out.code != 0 {
        let stderr = out.stderr_str();
        if rejected(&stderr) && !auth_failed(&stderr) {
            return Err("远程仓库有这台电脑上没有的提交，请先拉取再推送".into());
        }
        return remote_failure(&remote, creds, &out);
    }
    Ok(action(push_notice(&out.stdout_str(), &out.stderr_str())))
}

pub fn pull(root: &Path, local: LocalChanges) -> Result<GitAction, String> {
    with_lock(|| {
        let git = require_git()?;
        let creds = load_credentials(root)?;
        pull_locked(root, &git, creds.as_ref(), local)
    })
}

pub fn push(root: &Path) -> Result<GitAction, String> {
    with_lock(|| {
        let git = require_git()?;
        let creds = load_credentials(root)?;
        push_locked(root, &git, creds.as_ref())
    })
}

pub fn sync(root: &Path, local: LocalChanges) -> Result<GitAction, String> {
    with_lock(|| {
        let git = require_git()?;
        let creds = load_credentials(root)?;
        let pulled = pull_locked(root, &git, creds.as_ref(), local)?;
        if pulled.need_identity || pulled.need_credentials || pulled.need_choice {
            return Ok(pulled);
        }
        match push_locked(root, &git, creds.as_ref()) {
            Ok(pushed) if pushed.need_credentials => Ok(pushed),
            Ok(pushed) => Ok(action(combine_notice(&pulled.notice, &pushed.notice))),
            Err(e) if pulled.notice.contains('冲') => Err(format!("{}。推送失败：{e}", pulled.notice)),
            Err(e) => Err(format!("已经拉取，推送失败：{e}")),
        }
    })
}

fn combine_notice(pull: &str, push: &str) -> String {
    if pull.contains('冲') {
        format!("{pull}，并已推送")
    } else if (pull == "已是最新" || pull == NO_REMOTE_BRANCH) && push == "没有需要推送的提交" {
        "已是最新".into()
    } else {
        "已同步".into()
    }
}

/// 供 AI 生成提交说明：本次“提交全部改动”会包含的内容
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeDiff {
    /// 形如 “M 工作/周报.md”
    pub files: Vec<String>,
    pub diff: String,
    /// 改动过大，只保留了每个文件开头的部分差异
    pub truncated: bool,
}

const NEW_FILE_LINES: usize = 60;

fn text_of(bytes: &[u8]) -> Option<String> {
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes.to_vec()).ok()
}

/// 每个文件最多保留 limit 个字符，保证所有文件都能出现
pub fn fit_sections(sections: &[(String, String)], max_chars: usize) -> (String, bool) {
    let total: usize = sections.iter().map(|(h, b)| h.chars().count() + b.chars().count()).sum();
    if total <= max_chars {
        return (sections.iter().map(|(h, b)| format!("{h}\n{b}")).collect::<Vec<_>>().join("\n"), false);
    }
    let limit = (max_chars / sections.len().max(1)).max(300);
    let out = sections
        .iter()
        .map(|(h, b)| {
            if b.chars().count() <= limit {
                format!("{h}\n{b}")
            } else {
                format!("{h}\n{}\n…（此文件其余差异省略）", b.chars().take(limit).collect::<String>())
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    (out, true)
}

pub fn change_diff(root: &Path, max_chars: usize) -> Result<ChangeDiff, String> {
    with_lock(|| {
        let git = require_git()?;
        let parsed = read_parsed(root, &git)?;
        let has_head = run(root, &git, &["rev-parse", "--verify", "HEAD"])?.code == 0;
        let mut files = Vec::new();
        let mut sections = Vec::new();
        for change in &parsed.changes {
            files.push(format!("{} {}", change.letter, change.path));
            let body = if change.kind == ChangeKind::Added || !has_head {
                match fs::read(root.join(&change.path)).ok().as_deref().and_then(text_of) {
                    Some(text) => text.lines().take(NEW_FILE_LINES).map(|l| format!("+{l}")).collect::<Vec<_>>().join("\n"),
                    None => "（非文本文件）".into(),
                }
            } else {
                let out = run(root, &git, &["diff", "-U2", "HEAD", "--", &change.path])?;
                if out.code != 0 {
                    return Err(git_error(&out.stderr_str(), &out.stdout_str()));
                }
                let text = out.stdout_str();
                // 去掉 diff --git / index 等文件头，只保留改动内容
                text.lines().skip_while(|l| !l.starts_with("@@")).collect::<Vec<_>>().join("\n")
            };
            sections.push((format!("=== {} {}", change.letter, change.path), body));
        }
        let (diff, truncated) = fit_sections(&sections, max_chars);
        Ok(ChangeDiff { files, diff, truncated })
    })
}

pub fn log(root: &Path) -> Result<Vec<GitLogEntry>, String> {
    with_lock(|| {
        let Some(git) = locate_git() else {
            return Ok(Vec::new());
        };
        if !is_repo(root, &git)? {
            return Ok(Vec::new());
        }
        let out = run(root, &git, &["log", "-n", "40", "-z", "--format=%H%x1f%s%x1f%ct"])?;
        if out.code != 0 {
            let err = out.stderr_str();
            if err.contains("does not have any commits") || err.contains("没有任何提交") {
                return Ok(Vec::new());
            }
            return Err(git_error(&err, &out.stdout_str()));
        }
        let unpushed = unpushed_ids(root, &git)?;
        let mut entries = Vec::new();
        for record in out.stdout_str().split('\0') {
            if record.is_empty() {
                continue;
            }
            let mut parts = record.split('\u{1f}');
            let Some(id) = parts.next() else { continue };
            let subject = parts.next().unwrap_or("").to_string();
            let time = parts.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
            if id.is_empty() {
                continue;
            }
            let unpushed = match &unpushed {
                None => true,
                Some(set) => set.contains(id),
            };
            entries.push(GitLogEntry { id: id.to_string(), subject, time, unpushed });
        }
        Ok(entries)
    })
}

/// `None` 表示没有上游，提交都算尚未推送。
fn unpushed_ids(root: &Path, git: &Path) -> Result<Option<HashSet<String>>, String> {
    let parsed = read_parsed(root, git)?;
    if !parsed.has_upstream {
        return Ok(None);
    }
    let out = run(root, git, &["rev-list", "@{upstream}..HEAD"])?;
    if out.code != 0 {
        return Ok(None);
    }
    Ok(Some(out.stdout_str().lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn fit_sections_keeps_every_file_when_too_long() {
        let small = vec![("=== M a.md".to_string(), "+一".to_string())];
        assert_eq!(fit_sections(&small, 1000), ("=== M a.md\n+一".to_string(), false));
        let big: Vec<(String, String)> = (0..3).map(|i| (format!("=== M {i}.md"), "x".repeat(2000))).collect();
        let (text, truncated) = fit_sections(&big, 1500);
        assert!(truncated);
        assert!(text.contains("=== M 0.md") && text.contains("=== M 2.md"));
        assert!(text.chars().count() < 2500);
    }

    fn ch(path: &str, kind: ChangeKind) -> ParsedChange {
        ParsedChange { path: path.into(), kind, letter: 'M' }
    }

    #[test]
    fn gitignore_appends_missing_rules_and_keeps_the_rest() {
        let merged = merge_gitignore("notes.txt\r\n.ttnote/cache/\r\n");
        assert!(merged.contains("notes.txt\r\n"));
        assert!(merged.contains(".ttnote/history/\r\n"));
        assert!(merged.contains(".ttnote/trash/\r\n"));
        assert!(merged.contains(".ttnote/sync/\r\n"));
        assert_eq!(merged.matches(".ttnote/cache/").count(), 1);
        assert!(!merged.contains("!.ttnote/config/"));
        assert_eq!(merge_gitignore(&merged), merged);
    }

    #[test]
    fn gitignore_unignores_config_when_whole_ttnote_is_ignored() {
        let merged = merge_gitignore(".ttnote/\n");
        assert!(merged.contains("!.ttnote/config/\n"));
        assert!(merged.contains("!.ttnote/config/**\n"));
    }

    #[test]
    fn commit_message_names_notes_in_order() {
        let changes = vec![
            ch("读书笔记.md", ChangeKind::Added),
            ch("周报.md", ChangeKind::Modified),
            ch("会议纪要.md", ChangeKind::Modified),
        ];
        assert_eq!(
            auto_commit_message("自动提交", &changes),
            "自动提交：新增 1 篇（读书笔记）、修改 2 篇（周报、会议纪要）"
        );
        let many = vec![
            ch("周报.md", ChangeKind::Modified),
            ch("读书笔记.md", ChangeKind::Modified),
            ch("会议纪要.md", ChangeKind::Modified),
            ch("大纲.md", ChangeKind::Modified),
        ];
        assert_eq!(
            auto_commit_message("自动提交", &many),
            "自动提交：修改 4 篇（周报、读书笔记、会议纪要等）"
        );
        let mixed = vec![
            ch("旧草稿.md", ChangeKind::Deleted),
            ch("a.png", ChangeKind::Modified),
            ch("b.png", ChangeKind::Added),
        ];
        assert_eq!(
            auto_commit_message("自动提交", &mixed),
            "自动提交：删除 1 篇（旧草稿），以及其他 2 个文件"
        );
        assert_eq!(
            auto_commit_message("自动提交", &[ch("a.png", ChangeKind::Modified), ch("b.png", ChangeKind::Added)]),
            "自动提交：其他文件 2 个"
        );
        assert_eq!(
            auto_commit_message("拉取前自动提交", &[ch("周报.md", ChangeKind::Modified)]),
            "拉取前自动提交：修改 1 篇（周报）"
        );
        let dups = vec![ch("工作/周报.md", ChangeKind::Modified), ch("个人/周报.md", ChangeKind::Modified)];
        assert_eq!(
            auto_commit_message("自动提交", &dups),
            "自动提交：修改 2 篇（工作/周报、个人/周报）"
        );
    }

    #[test]
    fn conflict_names() {
        assert_eq!(
            conflict_rel("工作/周报.md", "OFFICE", "2026-09-28 1026", 1),
            "工作/周报 (冲突 OFFICE 2026-09-28 1026).md"
        );
        assert_eq!(
            conflict_rel("周报.md", "OFFICE", "2026-09-28 1026", 2),
            "周报 (冲突 OFFICE 2026-09-28 1026) 2.md"
        );
    }

    #[test]
    fn parses_porcelain_v2() {
        let raw = "\
# branch.oid abc\0\
# branch.head main\0\
# branch.upstream origin/main\0\
# branch.ab +1 -2\0\
1 .M N... 100644 100644 100644 2e65efe2a145dda7ee51d1741299f848e5bf752e 2e65efe2a145dda7ee51d1741299f848e5bf752e 工作/周报.md\0\
? 读书笔记.md\0\
1 .D N... 100644 100644 100644 2e65efe2a145dda7ee51d1741299f848e5bf752e 2e65efe2a145dda7ee51d1741299f848e5bf752e 旧草稿.md\0\
2 R. N... 100644 100644 100644 2e65efe2a145dda7ee51d1741299f848e5bf752e 2e65efe2a145dda7ee51d1741299f848e5bf752e R100 新周报.md\0\
旧周报.md\0";
        let parsed = parse_status_v2(raw);
        assert_eq!(parsed.branch.as_deref(), Some("main"));
        assert!(!parsed.detached);
        assert!(parsed.has_upstream);
        assert_eq!((parsed.ahead, parsed.behind), (1, 2));
        assert_eq!(parsed.changes.len(), 4);
        assert_eq!(parsed.changes[0].path, "工作/周报.md");
        assert_eq!(parsed.changes[0].letter, 'M');
        assert_eq!(parsed.changes[1].letter, 'A');
        assert_eq!(parsed.changes[2].letter, 'D');
        assert_eq!(parsed.changes[3].path, "新周报.md");
        assert_eq!(parsed.changes[3].kind, ChangeKind::Modified);
    }

    fn git_bin() -> PathBuf {
        locate_git().expect("测试需要系统里的 git")
    }

    fn git_at(dir: &Path, args: &[&str]) {
        let status = Command::new(git_bin())
            .current_dir(dir)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} 在 {} 失败", dir.display());
    }

    fn prep(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        init_repo(dir).unwrap();
        git_at(dir, &["config", "user.name", "测试"]);
        git_at(dir, &["config", "user.email", "test@example.com"]);
        git_at(dir, &["config", "commit.gpgsign", "false"]);
    }

    #[test]
    fn init_then_commit_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        prep(tmp.path());
        let ignore = fs::read_to_string(tmp.path().join(".gitignore")).unwrap();
        assert!(ignore.contains(".ttnote/cache/"));
        assert!(!ignore.contains(".ttnote/config/"));
        fs::write(tmp.path().join("周报.md"), "你好\n").unwrap();
        let before = status(tmp.path()).unwrap();
        assert!(before.changes.iter().any(|c| c.path == "周报.md" && c.letter == "A"));
        let done = commit(tmp.path(), "添加周报").unwrap();
        assert_eq!(done.notice, "已提交");
        let after = status(tmp.path()).unwrap();
        assert!(after.changes.is_empty(), "{:?}", after.changes);
        let again = commit(tmp.path(), "空").unwrap();
        assert_eq!(again.notice, "没有需要提交的改动");
        let entries = log(tmp.path()).unwrap();
        assert!(entries.iter().any(|e| e.subject == "添加周报" && e.unpushed), "{entries:?}");
    }

    #[test]
    fn parent_repository_is_not_the_vault() {
        let tmp = tempfile::tempdir().unwrap();
        prep(tmp.path());
        let sub = tmp.path().join("笔记");
        fs::create_dir_all(&sub).unwrap();
        let st = status(&sub).unwrap();
        assert!(st.installed);
        assert!(!st.is_repo);
    }

    #[test]
    fn missing_identity_is_filled_automatically() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path()).unwrap();
        init_repo(tmp.path()).unwrap();
        git_at(tmp.path(), &["config", "commit.gpgsign", "false"]);
        fs::write(tmp.path().join("a.md"), "x").unwrap();
        let done = commit(tmp.path(), "x").unwrap();
        assert!(!done.need_identity);
        assert_eq!(done.notice, "已提交");
        let st = status(tmp.path()).unwrap();
        assert!(!st.user_name.is_empty() && st.user_email.contains('@'));
        set_identity(tmp.path(), "测试", "test@example.com").unwrap();
        assert_eq!(status(tmp.path()).unwrap().user_name, "测试");
    }

    #[test]
    fn note_conflict_keeps_remote_name_and_local_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("origin.git");
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        git_at(tmp.path(), &["init", "--bare", "-b", "main", bare.to_str().unwrap()]);
        git_at(tmp.path(), &["clone", bare.to_str().unwrap(), "a"]);
        prep_existing(&a);
        fs::write(a.join("周报.md"), "base\n").unwrap();
        git_at(&a, &["add", "-A"]);
        git_at(&a, &["commit", "-m", "base"]);
        git_at(&a, &["push", "-u", "origin", "main"]);
        git_at(tmp.path(), &["clone", bare.to_str().unwrap(), "b"]);
        prep_existing(&b);
        fs::write(a.join("周报.md"), "remote-side\n").unwrap();
        git_at(&a, &["add", "-A"]);
        git_at(&a, &["commit", "-m", "remote"]);
        git_at(&a, &["push"]);
        fs::write(b.join("周报.md"), "local-side\n").unwrap();
        git_at(&b, &["add", "-A"]);
        git_at(&b, &["commit", "-m", "local"]);
        let report = pull(b.as_path(), LocalChanges::Keep).unwrap();
        assert!(report.notice.contains("保留两份"), "{}", report.notice);
        let kept = fs::read_to_string(b.join("周报.md")).unwrap();
        assert!(kept.contains("remote-side"), "{kept}");
        let copy = fs::read_dir(&b)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .find(|n| n.contains("冲突") && n.ends_with(".md"))
            .expect("冲突副本");
        let local = fs::read_to_string(b.join(copy)).unwrap();
        assert!(local.contains("local-side"), "{local}");
        assert!(!b.join(".git").join("MERGE_HEAD").exists());
    }

    #[test]
    fn non_note_conflict_aborts_merge() {
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("origin.git");
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        git_at(tmp.path(), &["init", "--bare", "-b", "main", bare.to_str().unwrap()]);
        git_at(tmp.path(), &["clone", bare.to_str().unwrap(), "a"]);
        prep_existing(&a);
        fs::write(a.join("pic.png"), b"base").unwrap();
        git_at(&a, &["add", "-A"]);
        git_at(&a, &["commit", "-m", "base"]);
        git_at(&a, &["push", "-u", "origin", "main"]);
        git_at(tmp.path(), &["clone", bare.to_str().unwrap(), "b"]);
        prep_existing(&b);
        fs::write(a.join("pic.png"), b"remote").unwrap();
        git_at(&a, &["add", "-A"]);
        git_at(&a, &["commit", "-m", "remote"]);
        git_at(&a, &["push"]);
        fs::write(b.join("pic.png"), b"local").unwrap();
        git_at(&b, &["add", "-A"]);
        git_at(&b, &["commit", "-m", "local"]);
        let err = pull(b.as_path(), LocalChanges::Keep).unwrap_err();
        assert!(err.contains("中止合并"), "{err}");
        assert!(!b.join(".git").join("MERGE_HEAD").exists());
        assert_eq!(fs::read(b.join("pic.png")).unwrap(), b"local");
    }

    #[test]
    fn saved_credentials_reach_git_and_system_helpers_are_skipped() {
        use std::io::Write;
        let tmp = tempfile::tempdir().unwrap();
        prep(tmp.path());
        let creds = Credentials { username: "张三 dev".into(), password: "p@ss word's \"x\"".into() };
        let mut cmd = remote_command(tmp.path(), &git_bin(), Some(&creds));
        cmd.args(["credential", "fill"]).stdin(Stdio::piped());
        let mut child = cmd.spawn().unwrap();
        child.stdin.take().unwrap().write_all(b"protocol=https\nhost=example.com\n\n").unwrap();
        let out = child.wait_with_output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(text.contains("username=张三 dev\n"), "{text}");
        assert!(text.contains("password=p@ss word's \"x\"\n"), "{text}");
    }

    #[test]
    fn detects_auth_failures() {
        assert!(auth_failed("fatal: could not read Username for 'https://github.com': terminal prompts disabled"));
        assert!(auth_failed("remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://gitlab.com/a/b.git/'"));
        assert!(auth_failed("fatal: unable to access 'https://x/': The requested URL returned error: 403"));
        assert!(auth_failed("fatal: Cannot prompt because user interactivity has been disabled.\nfatal: unable to get password from user"));
        assert!(!auth_failed("fatal: unable to access 'https://x/': Could not resolve host: x"));
        assert!(is_http_remote(" HTTPS://gitee.com/a/b.git"));
        assert!(!is_http_remote("git@github.com:a/b.git"));
    }

    #[test]
    fn first_sync_to_empty_remote_pushes() {
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("origin.git");
        let a = tmp.path().join("a");
        git_at(tmp.path(), &["init", "--bare", bare.to_str().unwrap()]);
        prep(&a);
        set_remote(&a, bare.to_str().unwrap()).unwrap();
        fs::write(a.join("周报.md"), "你好\n").unwrap();
        let done = sync(&a, LocalChanges::Keep).unwrap();
        assert!(!done.need_credentials && !done.need_identity);
        assert_eq!(done.notice, "已同步");
        let st = status(&a).unwrap();
        assert!(st.has_upstream && st.ahead == 0 && st.changes.is_empty(), "{st:?}");
    }

    #[test]
    fn first_pull_merges_remote_created_with_readme() {
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("origin.git");
        let web = tmp.path().join("web");
        let a = tmp.path().join("a");
        prep(&a);
        let branch = status(&a).unwrap().branch.unwrap();
        git_at(tmp.path(), &["init", "--bare", "-b", &branch, bare.to_str().unwrap()]);
        git_at(tmp.path(), &["clone", bare.to_str().unwrap(), "web"]);
        prep_existing(&web);
        fs::write(web.join("README.md"), "# 笔记\n").unwrap();
        git_at(&web, &["add", "-A"]);
        git_at(&web, &["commit", "-m", "Initial commit"]);
        git_at(&web, &["push", "origin", &branch]);
        set_remote(&a, bare.to_str().unwrap()).unwrap();
        fs::write(a.join("周报.md"), "你好\n").unwrap();
        let done = sync(&a, LocalChanges::Keep).unwrap();
        assert_eq!(done.notice, "已同步");
        assert!(a.join("README.md").is_file());
        assert!(a.join("周报.md").is_file());
    }

    /// 这次的问题：本地删了笔记再拉取，拉取前的自动提交把删除提交了，仓库里的笔记拿不回来
    #[test]
    fn pull_with_local_changes_asks_then_can_take_repository_version() {
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("origin.git");
        let a = tmp.path().join("a");
        git_at(tmp.path(), &["init", "--bare", bare.to_str().unwrap()]);
        prep(&a);
        set_remote(&a, bare.to_str().unwrap()).unwrap();
        fs::write(a.join("周报.md"), "仓库版本\n").unwrap();
        fs::write(a.join("读书.md"), "读书\n").unwrap();
        sync(&a, LocalChanges::Keep).unwrap();

        fs::remove_file(a.join("读书.md")).unwrap();
        fs::write(a.join("周报.md"), "本地改了\n").unwrap();
        fs::write(a.join("草稿.md"), "新写的\n").unwrap();
        let asked = sync(&a, LocalChanges::Ask).unwrap();
        assert!(asked.need_choice);
        assert!(a.join("草稿.md").is_file() && !a.join("读书.md").exists(), "询问时不能动文件");

        sync(&a, LocalChanges::Discard).unwrap();
        assert_eq!(fs::read_to_string(a.join("读书.md")).unwrap().trim(), "读书");
        assert_eq!(fs::read_to_string(a.join("周报.md")).unwrap().trim(), "仓库版本");
        assert!(!a.join("草稿.md").exists());
        assert!(a.join(".ttnote").join("trash").is_dir());
        let versions = history::list(&a, "周报.md").unwrap();
        assert!(versions.iter().any(|v| history::read(&a, "周报.md", &v.id).unwrap().contains("本地改了")));
        assert!(status(&a).unwrap().changes.is_empty());

        // 第二次：删除已经被提交了但还没推送（工作区是干净的），以仓库为准也要把它找回来
        fs::remove_file(a.join("读书.md")).unwrap();
        fs::write(a.join("新想法.md"), "只在本地提交过\n").unwrap();
        commit(&a, "删掉读书").unwrap();
        let asked = sync(&a, LocalChanges::Ask).unwrap();
        assert!(asked.need_choice);
        assert_eq!(asked.choice_files, vec!["读书.md".to_string()]);
        assert!(!a.join("读书.md").exists(), "询问时不能动文件");

        sync(&a, LocalChanges::Discard).unwrap();
        assert_eq!(fs::read_to_string(a.join("读书.md")).unwrap().trim(), "读书");
        assert!(!a.join("新想法.md").exists());
        let st = status(&a).unwrap();
        assert!(st.changes.is_empty() && st.ahead == 0, "{st:?}");
    }

    #[test]
    fn unpushed_edits_without_deletions_merge_without_asking() {
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("origin.git");
        let a = tmp.path().join("a");
        git_at(tmp.path(), &["init", "--bare", bare.to_str().unwrap()]);
        prep(&a);
        set_remote(&a, bare.to_str().unwrap()).unwrap();
        fs::write(a.join("周报.md"), "一\n").unwrap();
        sync(&a, LocalChanges::Keep).unwrap();
        fs::write(a.join("周报.md"), "二\n").unwrap();
        commit(&a, "改周报").unwrap();
        let done = sync(&a, LocalChanges::Ask).unwrap();
        assert!(!done.need_choice, "{done:?}");
        assert_eq!(done.notice, "已同步");
    }

    #[test]
    fn parses_ls_remote_symref() {
        let out = "ref: refs/heads/main\tHEAD\nabc\tHEAD\nabc\trefs/heads/main\ndef\trefs/heads/dev\nabc\trefs/tags/v1\n";
        let refs = parse_ls_remote(out);
        assert_eq!(refs.head.as_deref(), Some("main"));
        assert_eq!(refs.branches, vec!["main".to_string(), "dev".to_string()]);
        assert_eq!(parse_ls_remote("abc\trefs/heads/trunk\n").head.as_deref(), Some("trunk"));
        assert_eq!(parse_ls_remote(""), RemoteRefs::default());
    }

    #[test]
    fn auto_identity_needs_no_input() {
        assert_eq!(
            auto_identity(Some("zhangsan"), Some("https://github.com/zhangsan/notes.git"), "admin"),
            ("zhangsan".into(), "zhangsan@users.noreply.github.com".into())
        );
        assert_eq!(auto_identity(None, Some("git@gitee.com:li/notes.git"), "李四").1, "spark@users.noreply.gitee.com");
        assert_eq!(auto_identity(None, None, "admin"), ("admin".into(), "admin@spark.local".into()));
        assert_eq!(remote_host("ssh://git@gitlab.com:22/a/b.git").as_deref(), Some("gitlab.com"));
    }

    #[test]
    fn connect_to_remote_with_other_default_branch_then_sync_pulls_notes() {
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("origin.git");
        let web = tmp.path().join("web");
        let vault_dir = tmp.path().join("vault");
        git_at(tmp.path(), &["init", "--bare", "-b", "trunk", bare.to_str().unwrap()]);
        git_at(tmp.path(), &["clone", bare.to_str().unwrap(), "web"]);
        prep_existing(&web);
        fs::write(web.join("周报.md"), "远程的笔记\n").unwrap();
        git_at(&web, &["add", "-A"]);
        git_at(&web, &["commit", "-m", "远程"]);
        git_at(&web, &["push", "origin", "trunk"]);
        fs::create_dir_all(&vault_dir).unwrap();

        let done = connect(&vault_dir, bare.to_str().unwrap(), "", "").unwrap();
        assert!(!done.need_login && !done.remote_empty && !done.local_commits, "{done:?}");
        let st = status(&vault_dir).unwrap();
        assert_eq!(st.branch.as_deref(), Some("trunk"));
        assert!(!st.user_name.is_empty() && !st.user_email.is_empty());
        git_at(&vault_dir, &["config", "commit.gpgsign", "false"]);
        sync(&vault_dir, LocalChanges::Keep).unwrap();
        assert_eq!(fs::read_to_string(vault_dir.join("周报.md")).unwrap().trim(), "远程的笔记");
    }

    #[test]
    fn connect_to_empty_remote_reports_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("origin.git");
        let vault_dir = tmp.path().join("vault");
        git_at(tmp.path(), &["init", "--bare", bare.to_str().unwrap()]);
        fs::create_dir_all(&vault_dir).unwrap();
        let done = connect(&vault_dir, bare.to_str().unwrap(), "", "").unwrap();
        assert!(done.remote_empty && !done.need_login);
    }

    /// 克隆出来的仓库已经是仓库，只补身份和忽略签名，不再 init。
    fn prep_existing(dir: &Path) {
        git_at(dir, &["config", "user.name", "测试"]);
        git_at(dir, &["config", "user.email", "test@example.com"]);
        git_at(dir, &["config", "commit.gpgsign", "false"]);
    }
}
