//! WebDAV 同步。云端是正本：「上传」把本地改动推到云端，「同步」让本地与云端一致。
//! 会覆盖或删除文件的步骤先列清单，用户确认后才执行；被覆盖、删除的文件都能找回
//! （云端的移到 `.spark-trash/`，本地的存历史版本或移进回收站）。
//! 密码只进系统凭据库。上次同步的记录在 `.ttnote/sync/state.json`，不参与同步。

use crate::fsops;
use crate::history;
use crate::secret::{read_secret, write_secret};
use crate::vault::{self, atomic_write};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const STATE_NAME: &str = "state.json";
/// 云端回收文件夹，下一层按日期分目录，超过回收站保留天数后删除
const CLOUD_TRASH: &str = ".spark-trash";
/// 同步在后台线程执行，两次同步不能同时读写 state.json
static SYNC_LOCK: Mutex<()> = Mutex::new(());
const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    /// 本地 → 云端
    Upload,
    /// 云端 → 本地，云端为准
    Download,
}

/// 上传或同步时，一个文件要做的事
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    /// 对方没有，新增
    Add,
    /// 对方自上次同步后没变，直接更新
    Update,
    /// 对方也改过。上传时云端旧版移到云端回收文件夹；同步时本地旧版存历史版本（附件移进回收站）
    Overwrite,
    /// 上传时：本地删了，云端移到云端回收文件夹。同步时：云端删了，本地移进回收站
    Remove,
    /// 只提示不处理。上传时：本地删了但云端被改过。同步时：本地新建、还没上传
    Keep,
}

impl Step {
    fn needs_confirm(self) -> bool {
        matches!(self, Step::Overwrite | Step::Remove)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub rel: String,
    pub step: Step,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub upload: Vec<PlanItem>,
    pub download: Vec<PlanItem>,
    /// 云端文件比上次同步时少很多，可能地址或目录不对。有值时执行需要用户明确确认
    pub guard: Option<String>,
    pub local_files: u32,
    pub remote_files: u32,
    /// 上次完成上传或同步的时间（毫秒），0 表示从未同步
    pub last_sync_ms: u64,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub uploaded: u32,
    pub downloaded: u32,
    /// 移到云端回收文件夹的文件数
    pub remote_trashed: u32,
    /// 移进本地回收站的文件数
    pub local_trashed: u32,
    /// 需要确认但没被确认、或执行时本地又被改过而跳过的文件数
    pub skipped: u32,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub notes: u32,
    pub files: u32,
    /// 远程目录还不存在，第一次上传时创建
    pub missing: bool,
}

/// 笔记、附件（`*.assets/` 与根目录 `assets/`）和 `.ttnote/config/`。
pub fn should_sync(rel: &str) -> bool {
    let rel = rel.replace('\\', "/");
    if rel.is_empty() || rel.split('/').any(|p| p.is_empty() || p == "." || p == "..") {
        return false;
    }
    if rel.split('/').any(|p| p == ".git") {
        return false;
    }
    if rel == CLOUD_TRASH || rel.starts_with(".spark-trash/") {
        return false;
    }
    if rel == ".ttnote" || rel.starts_with(".ttnote/") {
        return rel.starts_with(".ttnote/config/") && rel != ".ttnote/config";
    }
    if rel == "assets" || rel.starts_with("assets/") {
        return rel != "assets";
    }
    if rel.split('/').any(|p| p.ends_with(".assets")) && !rel.ends_with(".assets") {
        return true;
    }
    Path::new(&rel).extension().is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
struct FileState {
    hash: String,
    etag: String,
    /// 记录 hash 时本地文件的大小和修改时间（纳秒）；下次扫描两者都没变就沿用 hash，不再读文件。0 表示未记录
    #[serde(default)]
    size: u64,
    #[serde(default)]
    mtime: u64,
}

/// 本次扫描到的本地文件
struct LocalFile {
    hash: String,
    size: u64,
    mtime: u64,
}

fn file_stat(meta: &fs::Metadata) -> (u64, u64) {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    (meta.len(), mtime)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StateFile {
    files: BTreeMap<String, FileState>,
    #[serde(default)]
    last_sync_ms: u64,
}

pub trait Dav {
    fn list(&self) -> Result<Vec<RemoteEntry>, String>;
    fn get(&self, rel: &str) -> Result<Vec<u8>, String>;
    fn put(&self, rel: &str, bytes: &[u8]) -> Result<String, String>;
    fn delete(&self, rel: &str) -> Result<(), String>;
    fn ensure_dir(&self, rel: &str) -> Result<(), String>;
    /// 移动远端文件，目标已存在时覆盖
    fn move_to(&self, from: &str, to: &str) -> Result<(), String>;
    /// 远程目录本身不存在时创建
    fn ensure_root(&self) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct RemoteEntry {
    pub rel: String,
    pub etag: String,
    pub is_dir: bool,
    /// 没有 ETag 时，用大小和修改时间判断远端是否变化
    pub size: Option<u64>,
    pub modified: String,
}

pub(crate) fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("读取失败 {}：{e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("读取失败 {}：{e}", path.display()))?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn list_local(root: &Path, state: &StateFile) -> Result<BTreeMap<String, LocalFile>, String> {
    let mut out = BTreeMap::new();
    walk(root, root, state, &mut out)?;
    Ok(out)
}

fn skip_dir(rel: &str) -> bool {
    rel == ".git"
        || rel.starts_with(".git/")
        || rel == ".ttnote/cache"
        || rel.starts_with(".ttnote/cache/")
        || rel == ".ttnote/history"
        || rel.starts_with(".ttnote/history/")
        || rel == ".ttnote/trash"
        || rel.starts_with(".ttnote/trash/")
        || rel == ".ttnote/sync"
        || rel.starts_with(".ttnote/sync/")
}

fn walk(root: &Path, dir: &Path, state: &StateFile, out: &mut BTreeMap<String, LocalFile>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("读取目录失败 {}：{e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录失败：{e}"))?;
        let path = entry.path();
        let rel = vault::rel_of(root, &path)?;
        let kind = entry.file_type().map_err(|e| format!("读取文件类型失败：{e}"))?;
        if kind.is_dir() {
            if skip_dir(&rel) {
                continue;
            }
            walk(root, &path, state, out)?;
        } else if kind.is_file() && should_sync(&rel) {
            // 先取大小和修改时间再读内容：读的过程中文件被改，下次扫描时修改时间对不上，会重新计算
            let meta = entry.metadata().map_err(|e| format!("读取文件信息失败 {}：{e}", path.display()))?;
            let (size, mtime) = file_stat(&meta);
            let hash = match state.files.get(&rel) {
                Some(s) if s.mtime != 0 && s.mtime == mtime && s.size == size => s.hash.clone(),
                _ => hash_file(&path)?,
            };
            out.insert(rel, LocalFile { hash, size, mtime });
        }
    }
    Ok(())
}

fn state_path(root: &Path) -> PathBuf {
    root.join(".ttnote").join("sync").join(STATE_NAME)
}

fn load_state(root: &Path) -> Result<StateFile, String> {
    let path = state_path(root);
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("同步状态损坏：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(StateFile::default()),
        Err(e) => Err(format!("读取同步状态失败：{e}")),
    }
}

fn save_state(root: &Path, state: &StateFile) -> Result<(), String> {
    let path = state_path(root);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建同步目录失败：{e}"))?;
    }
    atomic_write(&path, &serde_json::to_string_pretty(state).map_err(|e| e.to_string())?)
}

/// 去掉弱校验标记和引号，使同一资源的 ETag 每次比较都一致
fn normalize_etag(raw: &str) -> String {
    let mut s = raw.trim();
    if let Some(rest) = s.strip_prefix("W/").or_else(|| s.strip_prefix("w/")) {
        s = rest.trim();
    }
    s.trim_matches('"').trim().to_string()
}

/// 远端是否变化的令牌：有 ETag 用 ETag，否则用大小和修改时间。两者都没有时返回空串，由同步再按内容哈希比较。
fn remote_token(entry: &RemoteEntry) -> String {
    let etag = normalize_etag(&entry.etag);
    if !etag.is_empty() {
        return etag;
    }
    if entry.size.is_some() || !entry.modified.is_empty() {
        return format!("stat:{}:{}", entry.size.unwrap_or(0), entry.modified.trim());
    }
    String::new()
}

/// 一次扫描得到的两边现状
struct Scan {
    local: BTreeMap<String, LocalFile>,
    remote: BTreeMap<String, RemoteEntry>,
    /// 远端变化令牌；没有 ETag、大小和修改时间的文件用内容哈希
    tokens: BTreeMap<String, String>,
    /// `.spark-trash/<日期>` 目录
    trash_days: Vec<String>,
}

fn scan(root: &Path, dav: &dyn Dav, state: &StateFile) -> Result<Scan, String> {
    let local = list_local(root, state)?;
    let mut remote = BTreeMap::new();
    let mut trash_days = Vec::new();
    for entry in dav.list()? {
        if entry.is_dir {
            if entry.rel.strip_prefix(".spark-trash/").is_some_and(|day| !day.contains('/')) {
                trash_days.push(entry.rel.clone());
            }
            continue;
        }
        if should_sync(&entry.rel) {
            remote.insert(entry.rel.clone(), entry);
        }
    }
    let mut tokens = BTreeMap::new();
    for (rel, entry) in &remote {
        let mut token = remote_token(entry);
        if token.is_empty() {
            token = format!("hash:{}", hash_bytes(&dav.get(rel).map_err(|e| format!("{rel}：{e}"))?));
        }
        tokens.insert(rel.clone(), token);
    }
    Ok(Scan { local, remote, tokens, trash_days })
}

/// 两边都有、又不能从同步记录判断是否一致时比较内容。大小不同就不必下载。
fn same_content(dav: &dyn Dav, rel: &str, local: &LocalFile, remote: &RemoteEntry) -> Result<bool, String> {
    if remote.size.is_some_and(|s| s != local.size) {
        return Ok(false);
    }
    Ok(hash_bytes(&dav.get(rel)?) == local.hash)
}

fn record(state: &mut StateFile, rel: &str, local: &LocalFile, token: &str) {
    state.files.insert(rel.to_string(), FileState { hash: local.hash.clone(), etag: token.to_string(), size: local.size, mtime: local.mtime });
}

/// 按上次同步的记录判断两边各自变了没有，得出上传和同步时这个文件分别要做的事。
/// 两边已经一致时只更新记录。
fn classify(dav: &dyn Dav, rel: &str, scan: &Scan, state: &mut StateFile) -> Result<(Option<Step>, Option<Step>), String> {
    use Step::*;
    let base = state.files.get(rel).cloned();
    let local = scan.local.get(rel);
    let remote = scan.remote.get(rel).zip(scan.tokens.get(rel));
    let local_changed = match (&base, local) {
        (Some(b), Some(l)) => b.hash != l.hash,
        (None, None) => false,
        _ => true,
    };
    let remote_changed = match (&base, remote) {
        (Some(b), Some((_, token))) => &b.etag != token,
        (None, None) => false,
        _ => true,
    };
    Ok(match (local, remote) {
        (None, None) => {
            state.files.remove(rel);
            (None, None)
        }
        (Some(_), None) if base.is_none() => (Some(Add), Some(Keep)),
        (Some(_), None) => (local_changed.then_some(Add), Some(Remove)),
        (None, Some(_)) if base.is_none() => (None, Some(Add)),
        (None, Some(_)) => (Some(if remote_changed { Keep } else { Remove }), Some(Add)),
        (Some(l), Some((r, token))) => {
            if !local_changed && !remote_changed {
                record(state, rel, l, token);
                (None, None)
            } else if !remote_changed {
                (Some(Update), Some(Overwrite))
            } else if !local_changed {
                (None, Some(Update))
            } else if same_content(dav, rel, l, r).map_err(|e| format!("{rel}：{e}"))? {
                record(state, rel, l, token);
                (None, None)
            } else {
                (Some(Overwrite), Some(Overwrite))
            }
        }
    })
}

struct Planned {
    upload: Vec<PlanItem>,
    download: Vec<PlanItem>,
    guard: Option<String>,
}

fn plan_all(dav: &dyn Dav, scan: &Scan, state: &mut StateFile) -> Result<Planned, String> {
    let synced = state.files.len();
    let mut keys: Vec<String> = scan.local.keys().chain(scan.remote.keys()).chain(state.files.keys()).cloned().collect();
    keys.sort();
    keys.dedup();
    let mut planned = Planned { upload: Vec::new(), download: Vec::new(), guard: guard_message(synced, scan.remote.len()) };
    for rel in keys {
        let (up, down) = classify(dav, &rel, scan, state)?;
        if let Some(step) = up {
            planned.upload.push(PlanItem { rel: rel.clone(), step });
        }
        if let Some(step) = down {
            planned.download.push(PlanItem { rel, step });
        }
    }
    Ok(planned)
}

/// 云端文件比上次同步时少了很多，多半是地址、目录或账号不对，不能据此删除本地文件
pub fn guard_message(synced: usize, remote: usize) -> Option<String> {
    if synced > 0 && remote == 0 {
        return Some(format!("云端目录是空的，但上次同步时有 {synced} 个文件。可能是地址、远程目录或账号不对。"));
    }
    if synced >= 10 && remote * 2 < synced {
        return Some(format!("云端只有 {remote} 个文件，上次同步时有 {synced} 个。可能是地址、远程目录或账号不对。"));
    }
    None
}

pub fn preview(root: &Path, dav: &dyn Dav) -> Result<Preview, String> {
    let _guard = SYNC_LOCK.lock().map_err(|_| "同步状态异常".to_string())?;
    let mut state = load_state(root)?;
    let scan = scan(root, dav, &state)?;
    let planned = plan_all(dav, &scan, &mut state)?;
    save_state(root, &state)?;
    Ok(Preview {
        upload: planned.upload,
        download: planned.download,
        guard: planned.guard,
        local_files: scan.local.len() as u32,
        remote_files: scan.remote.len() as u32,
        last_sync_ms: state.last_sync_ms,
    })
}

/// 重新扫描后执行。需要确认的步骤只做 `accept` 里列出的文件；`force` 表示用户已确认云端异常也继续。
pub fn run(root: &Path, dav: &dyn Dav, direction: Direction, accept: &[String], force: bool, trash_days: u32) -> Result<SyncReport, String> {
    let _guard = SYNC_LOCK.lock().map_err(|_| "同步状态异常".to_string())?;
    let mut state = load_state(root)?;
    let scan = scan(root, dav, &state)?;
    let planned = plan_all(dav, &scan, &mut state)?;
    if let Some(msg) = planned.guard.as_ref().filter(|_| !force) {
        save_state(root, &state)?;
        return Err(msg.clone());
    }
    let accept: HashSet<&str> = accept.iter().map(String::as_str).collect();
    let items = match direction {
        Direction::Upload => planned.upload,
        Direction::Download => planned.download,
    };
    let mut report = SyncReport::default();
    let stamp = TrashStamp::now();
    let mut uploaded: HashMap<String, String> = HashMap::new();
    let writes_remote = items.iter().any(|i| matches!(i.step, Step::Add | Step::Update | Step::Overwrite));
    if direction == Direction::Upload && writes_remote && scan.remote.is_empty() {
        dav.ensure_root()?;
    }
    for item in &items {
        if item.step == Step::Keep {
            continue;
        }
        if item.step.needs_confirm() && !accept.contains(item.rel.as_str()) {
            report.skipped += 1;
            continue;
        }
        let result = match direction {
            Direction::Upload => upload_one(root, dav, item, &stamp, &mut state, &mut uploaded, &mut report),
            Direction::Download => download_one(root, dav, item, &scan, &mut state, &mut report),
        };
        if let Err(e) = result {
            report.errors.push(format!("{}：{e}", item.rel));
        }
    }
    if !uploaded.is_empty() {
        refresh_tokens(dav, &mut state, &uploaded);
    }
    if direction == Direction::Upload {
        prune_cloud_trash(dav, &scan.trash_days, trash_days, &mut report);
    }
    if report.errors.is_empty() {
        state.last_sync_ms = now_ms();
    }
    save_state(root, &state)?;
    Ok(report)
}

fn ensure_parent(dav: &dyn Dav, rel: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(rel).parent() {
        let parent = parent.to_string_lossy().replace('\\', "/");
        if !parent.is_empty() {
            dav.ensure_dir(&parent)?;
        }
    }
    Ok(())
}

fn upload_one(
    root: &Path,
    dav: &dyn Dav,
    item: &PlanItem,
    stamp: &TrashStamp,
    state: &mut StateFile,
    uploaded: &mut HashMap<String, String>,
    report: &mut SyncReport,
) -> Result<(), String> {
    let rel = item.rel.as_str();
    if matches!(item.step, Step::Overwrite | Step::Remove) {
        dav.move_to(rel, &stamp.cloud_path(rel))?;
        report.remote_trashed += 1;
        if item.step == Step::Remove {
            state.files.remove(rel);
            return Ok(());
        }
    }
    let path = vault::resolve(root, rel)?;
    let (size, mtime) = fs::metadata(&path).map(|m| file_stat(&m)).map_err(|e| format!("读取失败：{e}"))?;
    let bytes = fs::read(&path).map_err(|e| format!("读取失败：{e}"))?;
    ensure_parent(dav, rel)?;
    let etag = dav.put(rel, &bytes)?;
    let hash = hash_bytes(&bytes);
    state.files.insert(rel.to_string(), FileState { hash: hash.clone(), etag: normalize_etag(&etag), size, mtime });
    uploaded.insert(rel.to_string(), hash);
    report.uploaded += 1;
    Ok(())
}

fn download_one(root: &Path, dav: &dyn Dav, item: &PlanItem, scan: &Scan, state: &mut StateFile, report: &mut SyncReport) -> Result<(), String> {
    let rel = item.rel.as_str();
    let scanned = scan.local.get(rel).map(|l| l.hash.as_str());
    let dest = vault::resolve(root, rel)?;
    if item.step == Step::Remove {
        if dest.exists() {
            if !local_unchanged(root, rel, scanned)? {
                report.skipped += 1;
                return Ok(());
            }
            fsops::trash_entry(root, rel)?;
            report.local_trashed += 1;
        }
        state.files.remove(rel);
        return Ok(());
    }
    let bytes = dav.get(rel)?;
    if !local_unchanged(root, rel, scanned)? {
        report.skipped += 1;
        return Ok(());
    }
    if dest.exists() {
        if is_note(rel) {
            history::snapshot_now(root, rel)?;
        } else if item.step == Step::Overwrite {
            fsops::trash_entry(root, rel)?;
            report.local_trashed += 1;
        }
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    write_bytes(&dest, &bytes)?;
    let token = scan.tokens.get(rel).cloned().unwrap_or_default();
    // 不记录写入后的修改时间：写完到取时间之间用户可能又保存，下次扫描重新计算一次更稳妥
    state.files.insert(rel.to_string(), FileState { hash: hash_bytes(&bytes), etag: token, ..Default::default() });
    report.downloaded += 1;
    Ok(())
}

fn is_note(rel: &str) -> bool {
    Path::new(rel).extension().is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

/// 上传返回的 ETag 不一定和列目录时的一致，重新列一次，免得下次把自己刚传的文件当成云端更新
fn refresh_tokens(dav: &dyn Dav, state: &mut StateFile, uploaded: &HashMap<String, String>) {
    let Ok(list) = dav.list() else { return };
    for entry in list {
        let (Some(hash), Some(file)) = (uploaded.get(&entry.rel), state.files.get_mut(&entry.rel)) else { continue };
        let token = remote_token(&entry);
        file.etag = if token.is_empty() { format!("hash:{hash}") } else { token };
    }
}

fn prune_cloud_trash(dav: &dyn Dav, dirs: &[String], days: u32, report: &mut SyncReport) {
    if days == 0 {
        return;
    }
    let today = today_days();
    for dir in dirs {
        let Some(day) = dir.strip_prefix(".spark-trash/").and_then(parse_day) else { continue };
        if today - day > days as i64 {
            if let Err(e) = dav.delete(dir) {
                report.errors.push(format!("清理云端回收文件夹 {dir}：{e}"));
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 被覆盖或删除的云端文件放到 `.spark-trash/<日期>/<时分秒>/<原路径>`
struct TrashStamp {
    day: String,
    time: String,
}

impl TrashStamp {
    fn now() -> Self {
        let t = local_now();
        Self { day: format!("{:04}-{:02}-{:02}", t.0, t.1, t.2), time: format!("{:02}{:02}{:02}", t.3, t.4, t.5) }
    }

    fn cloud_path(&self, rel: &str) -> String {
        format!("{CLOUD_TRASH}/{}/{}/{rel}", self.day, self.time)
    }
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn parse_day(text: &str) -> Option<i64> {
    let mut parts = text.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (parts.next()??, parts.next()??, parts.next()??);
    if parts.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

fn today_days() -> i64 {
    let t = local_now();
    days_from_civil(t.0 as i64, t.1 as i64, t.2 as i64)
}

/// 扫描之后本地文件是否仍是扫描时的样子。同步期间用户可能又保存了，这时不能用远端内容覆盖或移入回收站；
/// 跳过且不更新同步状态，下次同步会按冲突处理、两份都保留。
fn local_unchanged(root: &Path, rel: &str, scanned: Option<&str>) -> Result<bool, String> {
    let path = vault::resolve(root, rel)?;
    if !path.exists() {
        return Ok(scanned.is_none());
    }
    Ok(scanned.is_some_and(|h| hash_file(&path).is_ok_and(|now| now == h)))
}

fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    vault::atomic_write_bytes(path, bytes)
}

/// 本地时间：年、月、日、时、分、秒
fn local_now() -> (u16, u16, u16, u16, u16, u16) {
    use chrono::{Datelike, Timelike};
    let t = chrono::Local::now();
    (t.year() as u16, t.month() as u16, t.day() as u16, t.hour() as u16, t.minute() as u16, t.second() as u16)
}

/// 解析 PROPFIND 的 multistatus，路径相对于 `prefix`（已解码、以 / 结尾的目录路径）。
pub fn parse_propfind(xml: &str, prefix: &str) -> Result<Vec<RemoteEntry>, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut entries = Vec::new();
    let mut href = String::new();
    let mut etag = String::new();
    let mut modified = String::new();
    let mut size: Option<u64> = None;
    let mut is_dir = false;
    let mut in_href = false;
    let mut in_etag = false;
    let mut in_len = false;
    let mut in_modified = false;
    let mut in_response = false;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = local_name(e.name().as_ref());
                match name.as_str() {
                    "response" => {
                        in_response = true;
                        href.clear();
                        etag.clear();
                        modified.clear();
                        size = None;
                        is_dir = false;
                        in_href = false;
                        in_etag = false;
                        in_len = false;
                        in_modified = false;
                    }
                    "href" if in_response => in_href = true,
                    "getetag" if in_response => in_etag = true,
                    "getcontentlength" if in_response => in_len = true,
                    "getlastmodified" if in_response => in_modified = true,
                    "collection" if in_response => is_dir = true,
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                if in_response && local_name(e.name().as_ref()) == "collection" {
                    is_dir = true;
                }
            }
            Ok(Event::Text(t)) => {
                let text = t.unescape().map_err(|e| format!("解析远端目录失败：{e}"))?.into_owned();
                if in_href { href.push_str(&text); }
                if in_etag { etag.push_str(text.trim()); }
                if in_modified { modified.push_str(text.trim()); }
                if in_len { size = text.trim().parse().ok(); }
            }
            Ok(Event::End(e)) => {
                let name = local_name(e.name().as_ref());
                match name.as_str() {
                    "href" => in_href = false,
                    "getetag" => in_etag = false,
                    "getcontentlength" => in_len = false,
                    "getlastmodified" => in_modified = false,
                    "response" => {
                        if let Some(rel) = href_to_rel(&href, prefix) {
                            if !rel.is_empty() {
                                entries.push(RemoteEntry {
                                    rel,
                                    etag: normalize_etag(&etag),
                                    is_dir,
                                    size,
                                    modified: modified.trim().to_string(),
                                });
                            }
                        }
                        in_response = false;
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("解析远端目录失败：{e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(entries)
}

fn local_name(qname: &[u8]) -> String {
    let raw = String::from_utf8_lossy(qname);
    raw.rsplit(':').next().unwrap_or("").to_ascii_lowercase()
}

fn href_to_rel(href: &str, prefix: &str) -> Option<String> {
    let decoded = percent_decode(href.split('?').next().unwrap_or(href));
    let path = if let Some(idx) = decoded.find("://") {
        let rest = &decoded[idx + 3..];
        rest.find('/').map(|i| rest[i..].to_string()).unwrap_or_else(|| "/".into())
    } else {
        decoded
    };
    let prefix = if prefix.ends_with('/') { prefix.to_string() } else { format!("{prefix}/") };
    let path = if path.ends_with('/') && path != prefix { path.trim_end_matches('/').to_string() } else { path };
    let rel = path.strip_prefix(prefix.trim_end_matches('/'))?.trim_start_matches('/');
    if rel.is_empty() { None } else { Some(rel.to_string()) }
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn percent_encode_path(rel: &str) -> String {
    rel.split('/').map(encode_segment).collect::<Vec<_>>().join("/")
}

fn encode_segment(seg: &str) -> String {
    let mut out = String::new();
    for b in seg.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub struct UreqDav {
    agent: ureq::Agent,
    /// 服务地址，不带结尾的 /
    server: String,
    /// 远程目录的各级名字
    dir: Vec<String>,
    base: String,
    auth: String,
    /// 上次列目录时远程目录不存在
    missing: Cell<bool>,
}

struct ListError {
    status: Option<u16>,
    message: String,
}

impl UreqDav {
    pub fn new(url: &str, remote_dir: &str, username: &str, password: &str) -> Result<Self, String> {
        let base = join_base(url, remote_dir)?;
        let token = base64_encode(format!("{username}:{password}").as_bytes());
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(60)).build();
        let server = url.trim().trim_end_matches('/').to_string();
        let dir = remote_dir.split('/').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect();
        Ok(Self { agent, server, dir, base, auth: format!("Basic {token}"), missing: Cell::new(false) })
    }

    /// 远程目录不存在时返回 `None`
    fn propfind(&self, url: &str, depth: &str) -> Result<Option<String>, ListError> {
        let sent = self.agent.request("PROPFIND", url)
            .set("Authorization", &self.auth)
            .set("Depth", depth)
            .set("Content-Type", "application/xml")
            .send_string(PROPFIND_BODY);
        match sent {
            Ok(response) => response.into_string().map(Some).map_err(|e| ListError { status: None, message: format!("读取远端目录失败：{e}") }),
            Err(ureq::Error::Status(404, _)) => Ok(None),
            Err(e) => {
                let status = if let ureq::Error::Status(code, _) = &e { Some(*code) } else { None };
                Err(ListError { status, message: http_err("读取远端目录失败", e) })
            }
        }
    }

    fn url_for(&self, rel: &str) -> String {
        let rel = rel.trim_matches('/');
        if rel.is_empty() { self.base.clone() } else { format!("{}{}", self.base, percent_encode_path(rel)) }
    }
}

fn join_base(url: &str, remote_dir: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/');
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("地址需要以 http:// 或 https:// 开头".into());
    }
    let dir = remote_dir.trim().trim_matches('/');
    let base = if dir.is_empty() { format!("{url}/") } else { format!("{url}/{}/", percent_encode_path(dir)) };
    Ok(base)
}

pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | bytes[i + 2] as u32;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(T[((n >> 6) & 63) as usize] as char);
        out.push(T[(n & 63) as usize] as char);
        i += 3;
    }
    if bytes.len() - i == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if bytes.len() - i == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(T[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

impl Dav for UreqDav {
    fn list(&self) -> Result<Vec<RemoteEntry>, String> {
        self.missing.set(false);
        // 有的服务不支持 Depth: infinity（坚果云等），改成逐层 Depth: 1
        let first = match self.propfind(&self.base, "infinity") {
            Err(e) if e.status != Some(401) => self.propfind(&self.base, "1"),
            other => other,
        };
        let Some(text) = first.map_err(|e| e.message)? else {
            self.missing.set(true);
            return Ok(Vec::new());
        };
        let prefix = list_prefix(&self.base);
        let mut entries = parse_propfind(&text, &prefix)?;
        let mut seen: HashSet<String> = entries.iter().map(|e| e.rel.clone()).collect();
        // 只拿到一层的服务不会列出子目录里的文件，没展开过的目录逐个再读
        let mut queue: Vec<String> = entries
            .iter()
            .filter(|d| d.is_dir && descend(&d.rel) && !entries.iter().any(|e| e.rel.starts_with(&format!("{}/", d.rel))))
            .map(|d| d.rel.clone())
            .collect();
        while let Some(dir) = queue.pop() {
            let url = format!("{}/", self.url_for(&dir));
            let Some(text) = self.propfind(&url, "1").map_err(|e| e.message)? else { continue };
            for entry in parse_propfind(&text, &prefix)? {
                if !seen.insert(entry.rel.clone()) {
                    continue;
                }
                if entry.is_dir && descend(&entry.rel) {
                    queue.push(entry.rel.clone());
                }
                entries.push(entry);
            }
        }
        Ok(entries)
    }

    fn move_to(&self, from: &str, to: &str) -> Result<(), String> {
        ensure_parent(self, to)?;
        let moved = self.agent.request("MOVE", &self.url_for(from))
            .set("Authorization", &self.auth)
            .set("Destination", &self.url_for(to))
            .set("Overwrite", "T")
            .call();
        match moved {
            Ok(_) | Err(ureq::Error::Status(404, _)) => Ok(()),
            Err(e) => {
                // 不支持 MOVE 的服务：复制过去再删除原文件
                let first = http_err("移到云端回收文件夹失败", e);
                let bytes = self.get(from).map_err(|_| first.clone())?;
                self.put(to, &bytes).map_err(|_| first.clone())?;
                self.delete(from)
            }
        }
    }

    fn ensure_root(&self) -> Result<(), String> {
        let mut url = self.server.clone();
        for part in &self.dir {
            url = format!("{url}/{}", encode_segment(part));
            if let Err(e) = self.agent.request("MKCOL", &format!("{url}/")).set("Authorization", &self.auth).call() {
                let text = format!("{e}");
                if !(text.contains("405") || text.contains("301") || text.contains("409")) {
                    return Err(http_err("创建远程目录失败", e));
                }
            }
        }
        Ok(())
    }

    fn get(&self, rel: &str) -> Result<Vec<u8>, String> {
        let response = self.agent.get(&self.url_for(rel)).set("Authorization", &self.auth).call().map_err(|e| http_err("下载失败", e))?;
        let mut bytes = Vec::new();
        response.into_reader().read_to_end(&mut bytes).map_err(|e| format!("下载失败：{e}"))?;
        Ok(bytes)
    }

    fn put(&self, rel: &str, bytes: &[u8]) -> Result<String, String> {
        let response = self.agent.put(&self.url_for(rel)).set("Authorization", &self.auth).send_bytes(bytes).map_err(|e| http_err("上传失败", e))?;
        Ok(response.header("ETag").unwrap_or("").trim_matches('"').to_string())
    }

    fn delete(&self, rel: &str) -> Result<(), String> {
        self.agent.delete(&self.url_for(rel)).set("Authorization", &self.auth).call().map(|_| ()).or_else(|e| {
            let text = format!("{e}");
            if text.contains("404") { Ok(()) } else { Err(http_err("删除远端文件失败", e)) }
        })
    }

    fn ensure_dir(&self, rel: &str) -> Result<(), String> {
        let mut acc = String::new();
        for part in rel.split('/').filter(|p| !p.is_empty()) {
            if !acc.is_empty() { acc.push('/'); }
            acc.push_str(part);
            let url = format!("{}/", self.url_for(&acc));
            if let Err(e) = self.agent.request("MKCOL", &url).set("Authorization", &self.auth).call() {
                let text = format!("{e}");
                if !(text.contains("405") || text.contains("301") || text.contains("409")) {
                    return Err(http_err("创建远端目录失败", e));
                }
            }
        }
        Ok(())
    }
}

/// 回收文件夹只需要列出日期那一层
fn descend(rel: &str) -> bool {
    !rel.starts_with(".spark-trash/")
}

fn url_path(url: &str) -> String {
    url.find("://").and_then(|i| url[i + 3..].find('/').map(|j| url[i + 3 + j..].to_string())).unwrap_or_else(|| "/".into())
}

/// 服务器返回的 href 解码后再和它比较，所以这里也要解码（远程目录含中文或空格时两者编码形式不同）
fn list_prefix(base: &str) -> String {
    percent_decode(&url_path(base))
}

fn http_err(context: &str, err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(401, _) => format!("{context}：账号或密码不正确（HTTP 401）"),
        ureq::Error::Status(code, response) => {
            let detail = response.into_string().unwrap_or_default();
            let detail = detail.chars().take(180).collect::<String>();
            if detail.is_empty() { format!("{context}：HTTP {code}") } else { format!("{context}：HTTP {code} {detail}") }
        }
        ureq::Error::Transport(t) => format!("{context}：{t}"),
    }
}

pub fn test_connection(url: &str, remote_dir: &str, username: &str, password: &str) -> Result<RemoteInfo, String> {
    let dav = UreqDav::new(url, remote_dir, username, password)?;
    let files: Vec<RemoteEntry> = dav.list()?.into_iter().filter(|e| !e.is_dir && should_sync(&e.rel)).collect();
    Ok(RemoteInfo {
        notes: files.iter().filter(|e| is_note(&e.rel)).count() as u32,
        files: files.len() as u32,
        missing: dav.missing.get(),
    })
}

pub fn preview_vault(root: &Path, url: &str, remote_dir: &str, username: &str, password: &str) -> Result<Preview, String> {
    let dav = UreqDav::new(url, remote_dir, username, password)?;
    preview(root, &dav)
}

#[allow(clippy::too_many_arguments)]
pub fn run_vault(
    root: &Path,
    url: &str,
    remote_dir: &str,
    username: &str,
    password: &str,
    direction: Direction,
    accept: &[String],
    force: bool,
) -> Result<SyncReport, String> {
    let dav = UreqDav::new(url, remote_dir, username, password)?;
    let (_, trash_days) = history::retention_days(root);
    run(root, &dav, direction, accept, force, trash_days)
}

const CRED_PREFIX: &str = "Spark:webdav:";

pub fn credential_account(root: &Path) -> String {
    format!("{CRED_PREFIX}{}", hash_bytes(root.to_string_lossy().as_bytes()))
}

pub fn save_password(root: &Path, password: &str) -> Result<(), String> {
    write_secret(&credential_account(root), password)
}

pub fn load_password(root: &Path) -> Result<Option<String>, String> {
    read_secret(&credential_account(root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_remote_dir_and_nested_hrefs_keep_full_paths() {
        let base = join_base("https://dav.example.com/dav/", "我的 笔记").unwrap();
        let prefix = list_prefix(&base);
        assert_eq!(prefix, "/dav/我的 笔记/");
        // 逐层读取子目录时，href 仍是绝对路径，按根前缀解析得到完整相对路径
        let xml = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/dav/%E6%88%91%E7%9A%84%20%E7%AC%94%E8%AE%B0/%E5%B7%A5%E4%BD%9C/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
  <d:response><d:href>https://dav.example.com/dav/%E6%88%91%E7%9A%84%20%E7%AC%94%E8%AE%B0/%E5%B7%A5%E4%BD%9C/%E5%91%A8%E6%8A%A5.md</d:href><d:propstat><d:prop><d:getetag>"e1"</d:getetag><d:resourcetype/></d:prop></d:propstat></d:response>
</d:multistatus>"#;
        let entries = parse_propfind(xml, &prefix).unwrap();
        assert!(entries.iter().any(|e| e.rel == "工作" && e.is_dir));
        assert!(entries.iter().any(|e| e.rel == "工作/周报.md" && !e.is_dir && e.etag == "e1"), "{entries:?}");
    }

    #[test]
    fn cloud_trash_is_never_synced() {
        assert!(!should_sync(".spark-trash/2026-09-28/153000/周报.md"));
        assert!(!descend(".spark-trash/2026-09-28"));
        assert!(descend(".spark-trash"));
        assert_eq!(parse_day("2026-09-28").unwrap() - parse_day("2026-08-29").unwrap(), 30);
        assert_eq!(parse_day("2026-03-01").unwrap() - parse_day("2026-02-28").unwrap(), 1);
        assert!(parse_day("2026-13-01").is_none());
    }

    #[test]
    fn sync_filter_skips_history_and_keeps_notes() {
        assert!(should_sync("工作/周报.md"));
        assert!(should_sync("周报.assets/a.png"));
        assert!(should_sync(".ttnote/config/order.json"));
        assert!(should_sync("assets/a.png"));
        assert!(!should_sync(".ttnote/history/a.md"));
        assert!(!should_sync(".ttnote/trash/1/a.md"));
        assert!(!should_sync(".ttnote/cache/index.db"));
        assert!(!should_sync(".ttnote/sync/state.json"));
        assert!(!should_sync(".git/config"));
        assert!(!should_sync("readme.txt"));
    }

    #[test]
    fn parses_propfind_hrefs() {
        let xml = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/dav/notes/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
  <d:response><d:href>/dav/notes/%E5%91%A8%E6%8A%A5.md</d:href><d:propstat><d:prop><d:getetag>"abc"</d:getetag><d:resourcetype></d:resourcetype></d:prop></d:propstat></d:response>
</d:multistatus>"#;
        let entries = parse_propfind(xml, "/dav/notes/").unwrap();
        assert!(entries.iter().any(|e| e.rel == "周报.md" && e.etag == "abc" && !e.is_dir));
    }

    #[test]
    fn parses_weak_etag_and_falls_back_to_size() {
        let xml = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/dav/notes/a.md</d:href><d:propstat><d:prop><d:getetag>W/"abc"</d:getetag><d:getcontentlength>4</d:getcontentlength><d:getlastmodified>Mon, 28 Sep 2026 01:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
  <d:response><d:href>/dav/notes/b.md</d:href><d:propstat><d:prop><d:getcontentlength>6</d:getcontentlength><d:getlastmodified>Tue, 29 Sep 2026 02:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
</d:multistatus>"#;
        let entries = parse_propfind(xml, "/dav/notes/").unwrap();
        let a = entries.iter().find(|e| e.rel == "a.md").unwrap();
        assert_eq!(a.etag, "abc");
        assert_eq!(a.size, Some(4));
        assert_eq!(remote_token(a), "abc");
        let b = entries.iter().find(|e| e.rel == "b.md").unwrap();
        assert!(b.etag.is_empty());
        assert_eq!(remote_token(b), "stat:6:Tue, 29 Sep 2026 02:00:00 GMT");
    }

    struct Mem {
        files: std::cell::RefCell<BTreeMap<String, Vec<u8>>>,
        /// 为 false 时不提供 ETag，只用大小和内容哈希充当修改时间
        etags: bool,
    }

    impl Dav for Mem {
        fn list(&self) -> Result<Vec<RemoteEntry>, String> {
            let etags = self.etags;
            let files = self.files.borrow();
            let mut dirs: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
            for rel in files.keys() {
                let mut acc = String::new();
                let parts: Vec<&str> = rel.split('/').collect();
                for part in &parts[..parts.len() - 1] {
                    if !acc.is_empty() { acc.push('/'); }
                    acc.push_str(part);
                    dirs.insert(acc.clone());
                }
            }
            let mut out: Vec<RemoteEntry> = dirs.into_iter().map(|rel| RemoteEntry { rel, etag: String::new(), is_dir: true, size: None, modified: String::new() }).collect();
            out.extend(files.iter().map(|(rel, bytes)| RemoteEntry {
                rel: rel.clone(),
                etag: if etags { hash_bytes(bytes) } else { String::new() },
                is_dir: false,
                size: Some(bytes.len() as u64),
                modified: if etags { String::new() } else { hash_bytes(bytes) },
            }));
            Ok(out)
        }
        fn get(&self, rel: &str) -> Result<Vec<u8>, String> {
            self.files.borrow().get(rel).cloned().ok_or_else(|| "没有这个远端文件".into())
        }
        fn put(&self, rel: &str, bytes: &[u8]) -> Result<String, String> {
            self.files.borrow_mut().insert(rel.to_string(), bytes.to_vec());
            Ok(hash_bytes(bytes))
        }
        fn delete(&self, rel: &str) -> Result<(), String> {
            let dir = format!("{rel}/");
            self.files.borrow_mut().retain(|k, _| k != rel && !k.starts_with(&dir));
            Ok(())
        }
        fn ensure_dir(&self, _rel: &str) -> Result<(), String> { Ok(()) }
        fn move_to(&self, from: &str, to: &str) -> Result<(), String> {
            let mut files = self.files.borrow_mut();
            if let Some(bytes) = files.remove(from) {
                files.insert(to.to_string(), bytes);
            }
            Ok(())
        }
    }

    fn mem(files: &[(&str, &str)], etags: bool) -> Mem {
        let map = files.iter().map(|(k, v)| (k.to_string(), v.as_bytes().to_vec())).collect();
        Mem { files: std::cell::RefCell::new(map), etags }
    }

    fn cloud(dav: &Mem, rel: &str) -> Option<String> {
        dav.files.borrow().get(rel).map(|b| String::from_utf8_lossy(b).into_owned())
    }

    fn cloud_trash(dav: &Mem) -> Vec<(String, String)> {
        dav.files.borrow().iter().filter(|(k, _)| k.starts_with(".spark-trash/")).map(|(k, v)| (k.clone(), String::from_utf8_lossy(v).into_owned())).collect()
    }

    fn steps(items: &[PlanItem]) -> Vec<(&str, Step)> {
        items.iter().map(|i| (i.rel.as_str(), i.step)).collect()
    }

    fn all(items: &[PlanItem]) -> Vec<String> {
        items.iter().map(|i| i.rel.clone()).collect()
    }

    fn upload(root: &Path, dav: &dyn Dav, accept: &[String]) -> SyncReport {
        run(root, dav, Direction::Upload, accept, false, 30).unwrap()
    }

    fn download(root: &Path, dav: &dyn Dav, accept: &[String]) -> SyncReport {
        run(root, dav, Direction::Download, accept, false, 30).unwrap()
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn uploads_once_then_nothing_pending() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "周报.md", "你好");
        write(tmp.path(), "工作/会议.md", "纪要");
        let dav = mem(&[], true);
        let p = preview(tmp.path(), &dav).unwrap();
        assert_eq!(steps(&p.upload), vec![("周报.md", Step::Add), ("工作/会议.md", Step::Add)]);
        assert_eq!(p.last_sync_ms, 0);
        let report = upload(tmp.path(), &dav, &[]);
        assert_eq!(report.uploaded, 2, "{report:?}");
        assert_eq!(cloud(&dav, "工作/会议.md").as_deref(), Some("纪要"));
        let again = preview(tmp.path(), &dav).unwrap();
        assert!(again.upload.is_empty() && again.download.is_empty(), "{again:?}");
        assert!(again.last_sync_ms > 0);
    }

    /// 这次事故：上传后云端列表读成空的，下一次同步不能把本地文件收走
    #[test]
    fn empty_listing_after_upload_never_trashes_local_without_confirmation() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "周报.md", "你好");
        let dav = mem(&[], true);
        upload(tmp.path(), &dav, &[]);
        dav.files.borrow_mut().clear();
        let p = preview(tmp.path(), &dav).unwrap();
        assert!(p.guard.is_some());
        assert_eq!(steps(&p.download), vec![("周报.md", Step::Remove)]);
        let err = run(tmp.path(), &dav, Direction::Download, &all(&p.download), false, 30).unwrap_err();
        assert!(err.contains("云端目录是空的"), "{err}");
        assert!(tmp.path().join("周报.md").is_file());
        // 未勾选的删除即使强制继续也不执行
        let report = run(tmp.path(), &dav, Direction::Download, &[], true, 30).unwrap();
        assert_eq!(report.skipped, 1);
        assert!(tmp.path().join("周报.md").is_file());
    }

    #[test]
    fn guard_thresholds() {
        assert!(guard_message(0, 0).is_none());
        assert!(guard_message(3, 0).is_some());
        assert!(guard_message(3, 1).is_none());
        assert!(guard_message(10, 4).is_some());
        assert!(guard_message(10, 5).is_none());
    }

    #[test]
    fn download_overwrites_local_edit_only_when_confirmed_and_keeps_history() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "周报.md", "你好");
        let dav = mem(&[], true);
        upload(tmp.path(), &dav, &[]);
        write(tmp.path(), "周报.md", "本地改");
        dav.put("周报.md", "云端改".as_bytes()).unwrap();
        let p = preview(tmp.path(), &dav).unwrap();
        assert_eq!(steps(&p.download), vec![("周报.md", Step::Overwrite)]);
        assert_eq!(steps(&p.upload), vec![("周报.md", Step::Overwrite)]);
        let skipped = download(tmp.path(), &dav, &[]);
        assert_eq!(skipped.skipped, 1);
        assert_eq!(fs::read_to_string(tmp.path().join("周报.md")).unwrap(), "本地改");
        let done = download(tmp.path(), &dav, &all(&p.download));
        assert_eq!(done.downloaded, 1, "{done:?}");
        assert_eq!(fs::read_to_string(tmp.path().join("周报.md")).unwrap(), "云端改");
        let versions = history::list(tmp.path(), "周报.md").unwrap();
        assert!(versions.iter().any(|v| history::read(tmp.path(), "周报.md", &v.id).unwrap() == "本地改"));
    }

    #[test]
    fn upload_overwrite_moves_old_cloud_version_to_cloud_trash() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "周报.md", "你好");
        let dav = mem(&[], true);
        upload(tmp.path(), &dav, &[]);
        write(tmp.path(), "周报.md", "本地改");
        dav.put("周报.md", "云端改".as_bytes()).unwrap();
        let p = preview(tmp.path(), &dav).unwrap();
        let report = upload(tmp.path(), &dav, &all(&p.upload));
        assert_eq!((report.uploaded, report.remote_trashed), (1, 1), "{report:?}");
        assert_eq!(cloud(&dav, "周报.md").as_deref(), Some("本地改"));
        let trash = cloud_trash(&dav);
        assert!(trash.iter().any(|(k, v)| k.ends_with("/周报.md") && v == "云端改"), "{trash:?}");
        let again = preview(tmp.path(), &dav).unwrap();
        assert!(again.upload.is_empty() && again.download.is_empty(), "{again:?}");
    }

    #[test]
    fn local_delete_uploads_to_cloud_trash_and_download_restores() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "周报.md", "你好");
        let dav = mem(&[], true);
        upload(tmp.path(), &dav, &[]);
        fs::remove_file(tmp.path().join("周报.md")).unwrap();
        let p = preview(tmp.path(), &dav).unwrap();
        assert_eq!(steps(&p.upload), vec![("周报.md", Step::Remove)]);
        assert_eq!(steps(&p.download), vec![("周报.md", Step::Add)]);
        assert_eq!(download(tmp.path(), &dav, &[]).downloaded, 1);
        assert_eq!(fs::read_to_string(tmp.path().join("周报.md")).unwrap(), "你好");

        fs::remove_file(tmp.path().join("周报.md")).unwrap();
        let report = upload(tmp.path(), &dav, &["周报.md".into()]);
        assert_eq!(report.remote_trashed, 1);
        assert!(cloud(&dav, "周报.md").is_none());
        assert!(cloud_trash(&dav).iter().any(|(k, v)| k.ends_with("/周报.md") && v == "你好"));
    }

    #[test]
    fn cloud_delete_moves_local_to_trash_when_confirmed() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "a.md", "一");
        write(tmp.path(), "b.md", "二");
        let dav = mem(&[], true);
        upload(tmp.path(), &dav, &[]);
        dav.delete("a.md").unwrap();
        let p = preview(tmp.path(), &dav).unwrap();
        assert!(p.guard.is_none());
        assert_eq!(steps(&p.download), vec![("a.md", Step::Remove)]);
        let report = download(tmp.path(), &dav, &all(&p.download));
        assert_eq!(report.local_trashed, 1);
        assert!(!tmp.path().join("a.md").exists());
        assert!(tmp.path().join(".ttnote").join("trash").is_dir());
    }

    #[test]
    fn local_only_notes_survive_download() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "新写的.md", "本地");
        let dav = mem(&[("云端的.md", "云端")], true);
        let p = preview(tmp.path(), &dav).unwrap();
        assert_eq!(steps(&p.download), vec![("云端的.md", Step::Add), ("新写的.md", Step::Keep)]);
        let report = download(tmp.path(), &dav, &[]);
        assert_eq!(report.downloaded, 1);
        assert_eq!(fs::read_to_string(tmp.path().join("新写的.md")).unwrap(), "本地");
        assert_eq!(fs::read_to_string(tmp.path().join("云端的.md")).unwrap(), "云端");
    }

    #[test]
    fn identical_files_on_both_sides_need_nothing_even_without_etags() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "周报.md", "你好");
        let dav = mem(&[("周报.md", "你好")], false);
        let p = preview(tmp.path(), &dav).unwrap();
        assert!(p.upload.is_empty() && p.download.is_empty(), "{p:?}");
        dav.put("周报.md", "改了".as_bytes()).unwrap();
        let p = preview(tmp.path(), &dav).unwrap();
        assert_eq!(steps(&p.download), vec![("周报.md", Step::Update)]);
        assert_eq!(download(tmp.path(), &dav, &[]).downloaded, 1);
        assert_eq!(fs::read_to_string(tmp.path().join("周报.md")).unwrap(), "改了");
        let again = preview(tmp.path(), &dav).unwrap();
        assert!(again.upload.is_empty() && again.download.is_empty(), "{again:?}");
    }

    #[test]
    fn old_cloud_trash_is_pruned_on_upload() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "周报.md", "你好");
        let dav = mem(&[(".spark-trash/2020-01-01/000000/旧.md", "旧"), (".spark-trash/2999-01-01/000000/新.md", "新")], true);
        upload(tmp.path(), &dav, &[]);
        let trash = cloud_trash(&dav);
        assert_eq!(trash.len(), 1, "{trash:?}");
        assert!(trash[0].0.starts_with(".spark-trash/2999-01-01/"));
    }

    #[test]
    fn unchanged_size_and_mtime_reuse_hash_until_file_is_touched() {
        let tmp = tempfile::tempdir().unwrap();
        let note = tmp.path().join("周报.md");
        fs::write(&note, "你好").unwrap();
        let dav = mem(&[], true);
        upload(tmp.path(), &dav, &[]);
        let mtime = fs::metadata(&note).unwrap().modified().unwrap();

        // 大小和修改时间都没变时不重新读文件，所以这次改动（刻意还原了修改时间）不会被发现
        fs::write(&note, "我好").unwrap();
        File::options().write(true).open(&note).unwrap().set_modified(mtime).unwrap();
        assert_eq!(upload(tmp.path(), &dav, &[]).uploaded, 0);

        File::options().write(true).open(&note).unwrap().set_modified(mtime + Duration::from_secs(1)).unwrap();
        assert_eq!(upload(tmp.path(), &dav, &[]).uploaded, 1);
        assert_eq!(cloud(&dav, "周报.md").as_deref(), Some("我好"));
    }

    /// 本地扫描之后、应用计划之前改写本地文件，模拟同步过程中用户又保存了一次
    struct SaveMidway<'a> {
        inner: &'a Mem,
        path: PathBuf,
        text: &'static str,
    }

    impl Dav for SaveMidway<'_> {
        fn list(&self) -> Result<Vec<RemoteEntry>, String> {
            fs::write(&self.path, self.text).unwrap();
            self.inner.list()
        }
        fn get(&self, rel: &str) -> Result<Vec<u8>, String> { self.inner.get(rel) }
        fn put(&self, rel: &str, bytes: &[u8]) -> Result<String, String> { self.inner.put(rel, bytes) }
        fn delete(&self, rel: &str) -> Result<(), String> { self.inner.delete(rel) }
        fn ensure_dir(&self, rel: &str) -> Result<(), String> { self.inner.ensure_dir(rel) }
        fn move_to(&self, from: &str, to: &str) -> Result<(), String> { self.inner.move_to(from, to) }
    }

    #[test]
    fn download_skips_note_saved_during_sync_then_asks_before_overwrite() {
        let tmp = tempfile::tempdir().unwrap();
        let note = tmp.path().join("周报.md");
        fs::write(&note, "你好").unwrap();
        let dav = mem(&[], true);
        upload(tmp.path(), &dav, &[]);
        dav.put("周报.md", "远端改了".as_bytes()).unwrap();

        let midway = SaveMidway { inner: &dav, path: note.clone(), text: "本地新保存" };
        let report = download(tmp.path(), &midway, &[]);
        assert_eq!((report.downloaded, report.skipped), (0, 1), "{report:?}");
        assert_eq!(fs::read_to_string(&note).unwrap(), "本地新保存");

        let p = preview(tmp.path(), &dav).unwrap();
        assert_eq!(steps(&p.download), vec![("周报.md", Step::Overwrite)]);
    }

    #[test]
    fn remote_delete_keeps_note_saved_during_sync() {
        let tmp = tempfile::tempdir().unwrap();
        let note = tmp.path().join("周报.md");
        fs::write(&note, "你好").unwrap();
        write(tmp.path(), "其他.md", "占位");
        let dav = mem(&[], true);
        upload(tmp.path(), &dav, &[]);
        dav.delete("周报.md").unwrap();

        let midway = SaveMidway { inner: &dav, path: note.clone(), text: "本地新保存" };
        let report = download(tmp.path(), &midway, &["周报.md".into()]);
        assert_eq!((report.local_trashed, report.skipped), (0, 1), "{report:?}");
        assert_eq!(fs::read_to_string(&note).unwrap(), "本地新保存");

        let p = preview(tmp.path(), &dav).unwrap();
        assert_eq!(steps(&p.upload), vec![("周报.md", Step::Add)]);
    }
}
