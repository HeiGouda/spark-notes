//! 文件的创建时间和修改时间，记在 `.ttnote/config/times.json`，随笔记库同步。
//!
//! 文件系统的时间不可靠：同步下载、Git 检出会把它改成写入那一刻，保存时“先写临时文件再改名”
//! 还会让 Windows 上的创建时间每次都变。这里按内容哈希判断文件是否真的改过：同步下来的文件
//! 内容与记录一致，不算修改；在本应用或其他编辑器里改过的，修改时间取文件的修改时间。
//!
//! 每条记录单独一行、按路径排序，Git 合并时不同文件的记录互不冲突；同一条记录两边都改过时，
//! 创建时间取早的，修改时间取晚的（见 `merge_stamp`）。

use crate::vault::{self, TreeNode};
use crate::{fsops, git, history, webdav};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub const CONFIG_NAME: &str = "times.json";
/// 相对笔记库根目录的路径
pub const REL: &str = ".ttnote/config/times.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stamp {
    pub created: u64,
    pub modified: u64,
    /// 记下修改时间时的内容哈希；文件夹没有
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub hash: String,
}

pub type Times = BTreeMap<String, Stamp>;

/// 读改写 times.json 的锁
static LOCK: Mutex<()> = Mutex::new(());

/// 内容哈希缓存：笔记库 → 相对路径 → (大小, 修改时间纳秒, 哈希)。大小和修改时间都没变就不再读文件
type HashCache = HashMap<PathBuf, HashMap<String, (u64, u128, String)>>;

fn hash_cache() -> &'static Mutex<HashCache> {
    static CACHE: OnceLock<Mutex<HashCache>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 同一个文件的两条记录：创建时间取早的，修改时间和内容哈希取改得晚的那条
pub fn merge_stamp(a: &Stamp, b: &Stamp) -> Stamp {
    let created = match (a.created, b.created) {
        (0, x) | (x, 0) => x,
        (x, y) => x.min(y),
    };
    let newer = if b.modified > a.modified { b } else { a };
    Stamp { created, modified: newer.modified, hash: newer.hash.clone() }
}

fn insert(times: &mut Times, key: String, stamp: Stamp) {
    let merged = match times.get(&key) {
        Some(old) => merge_stamp(old, &stamp),
        None => stamp,
    };
    times.insert(key, merged);
}

/// 解析 times.json。整体解析失败时（Git 合并留下的冲突标记、少了逗号等）逐行读出每条记录，
/// 同一路径出现多次时按 `merge_stamp` 合并。
pub fn parse(text: &str) -> Times {
    if let Ok(times) = serde_json::from_str::<Times>(text) {
        return times;
    }
    let mut out = Times::new();
    for line in text.lines() {
        let item = line.trim().trim_end_matches(',');
        if !item.starts_with('"') {
            continue;
        }
        if let Ok(one) = serde_json::from_str::<Times>(&format!("{{{item}}}")) {
            for (k, v) in one {
                insert(&mut out, k, v);
            }
        }
    }
    out
}

pub fn serialize(times: &Times) -> String {
    let mut s = String::from("{\n");
    let last = times.len().saturating_sub(1);
    for (i, (k, v)) in times.iter().enumerate() {
        let key = serde_json::to_string(k).unwrap_or_default();
        let value = serde_json::to_string(v).unwrap_or_default();
        s.push_str(&format!("  {key}: {value}{}\n", if i < last { "," } else { "" }));
    }
    s.push_str("}\n");
    s
}

/// 合并两份 times.json 的内容（同步冲突时用）
pub fn merge_text(a: &str, b: &str) -> String {
    let mut out = parse(a);
    for (k, v) in parse(b) {
        insert(&mut out, k, v);
    }
    serialize(&out)
}

fn load(root: &Path) -> Result<Times, String> {
    Ok(fsops::config_read(root, CONFIG_NAME)?.map(|s| parse(&s)).unwrap_or_default())
}

fn save(root: &Path, times: &Times) -> Result<(), String> {
    fsops::config_write(root, CONFIG_NAME, &serialize(times))
}

fn short_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn content_hash(root: &Path, rel: &str) -> Result<String, String> {
    let path = vault::resolve(root, rel)?;
    let meta = fs::metadata(&path).map_err(|e| format!("读取文件信息失败 {rel}：{e}"))?;
    let size = meta.len();
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
    let mut cache = hash_cache().lock().map_err(|_| "时间记录状态异常".to_string())?;
    let files = cache.entry(root.to_path_buf()).or_default();
    if let Some((s, m, h)) = files.get(rel) {
        if *s == size && *m == mtime && mtime != 0 {
            return Ok(h.clone());
        }
    }
    let bytes = fs::read(&path).map_err(|e| format!("读取失败 {rel}：{e}"))?;
    let hash = short_hash(&bytes);
    files.insert(rel.to_string(), (size, mtime, hash.clone()));
    Ok(hash)
}

/// Front Matter 里的 `created: 2026-09-01`（可带 `10:20` 这样的时间），按本机时区
fn front_matter_created(text: &str) -> Option<u64> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    for line in lines {
        let line = line.trim_end();
        if line == "---" {
            break;
        }
        let Some(value) = line.strip_prefix("created").and_then(|v| v.trim_start().strip_prefix(':')) else { continue };
        return parse_local_time(value.trim().trim_matches(|c| c == '"' || c == '\''));
    }
    None
}

fn parse_local_time(value: &str) -> Option<u64> {
    use chrono::{Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
    let date = NaiveDate::parse_from_str(value.get(..10)?, "%Y-%m-%d").ok()?;
    let rest = value[10..].trim_start_matches(['T', ' ']);
    let time = rest
        .get(..5)
        .and_then(|t| NaiveTime::parse_from_str(t, "%H:%M").ok())
        .or_else(|| NaiveTime::from_hms_opt(0, 0, 0))?;
    let ms = Local.from_local_datetime(&NaiveDateTime::new(date, time)).earliest()?.timestamp_millis();
    u64::try_from(ms).ok()
}

/// 还没有记录的文件第一次记下的创建时间。Front Matter 写明了就用它；否则 Git 第一次提交、
/// 最早的历史版本、文件系统的创建和修改时间都只会晚于真正的创建时间，取其中最早的。
fn first_created(root: &Path, node: &TreeNode, git_first: Option<u64>) -> Option<u64> {
    if node.path.ends_with(".md") {
        if let Some(t) = vault::resolve(root, &node.path).ok().and_then(|p| fs::read_to_string(p).ok()).and_then(|s| front_matter_created(&s)) {
            return Some(t);
        }
    }
    [git_first, history::earliest_ms(root, &node.path), node.created_ms, node.modified_ms].into_iter().flatten().min()
}

fn flatten<'a>(nodes: &'a [TreeNode], out: &mut Vec<&'a TreeNode>) {
    for n in nodes {
        out.push(n);
        if n.is_dir {
            flatten(&n.children, out);
        }
    }
}

/// 按磁盘现状更新记录：补记新文件，内容变了的更新修改时间，去掉已不存在的
fn reconcile(root: &Path, nodes: &[TreeNode], times: &mut Times) {
    let mut all = Vec::new();
    flatten(nodes, &mut all);
    let present: HashSet<&str> = all.iter().map(|n| n.path.as_str()).collect();
    times.retain(|k, _| present.contains(k.as_str()));

    let adopting = all.iter().any(|n| !n.is_dir && !times.contains_key(&n.path));
    let git_times = if adopting {
        git::file_times(root).unwrap_or_else(|e| {
            eprintln!("读取 Git 提交时间失败，按文件时间补记：{e}");
            git::FileTimes::default()
        })
    } else {
        git::FileTimes::default()
    };
    let now = now_ms();
    for n in all.iter().filter(|n| !n.is_dir) {
        // 扫描之后文件又被删掉或正在写入时读不到，留到下次
        let Ok(hash) = content_hash(root, &n.path) else { continue };
        let fs_modified = n.modified_ms.unwrap_or(now);
        if let Some(s) = times.get_mut(&n.path) {
            if s.hash != hash {
                if !s.hash.is_empty() {
                    s.modified = if fs_modified > s.modified { fs_modified } else { now };
                }
                s.hash = hash;
            }
            continue;
        }
        let commit = git_times.commits.get(&n.path).copied();
        let modified = match commit {
            Some((_, last)) if !git_times.dirty.contains(&n.path) => last,
            _ => fs_modified,
        };
        let created = first_created(root, n, commit.map(|c| c.0)).unwrap_or(modified);
        times.insert(n.path.clone(), Stamp { created: created.min(modified), modified, hash });
    }
    adopt_dirs(nodes, times);
}

/// 没有记录的文件夹：创建时间取它自己和其中各项创建时间里最早的。返回这一层里最早的创建时间
fn adopt_dirs(nodes: &[TreeNode], times: &mut Times) -> Option<u64> {
    let mut earliest: Option<u64> = None;
    for n in nodes {
        if n.is_dir {
            let inner = adopt_dirs(&n.children, times);
            if !times.contains_key(&n.path) {
                if let Some(c) = [n.created_ms, n.modified_ms, inner].into_iter().flatten().min() {
                    times.insert(n.path.clone(), Stamp { created: c, modified: c, hash: String::new() });
                }
            }
        }
        if let Some(c) = times.get(&n.path).map(|s| s.created) {
            earliest = Some(earliest.map_or(c, |e| e.min(c)));
        }
    }
    earliest
}

/// 把记录的时间写进树节点。文件夹的修改时间取其中最近修改的项，空文件夹取创建时间。返回这一层里最新的修改时间
fn assign(nodes: &mut [TreeNode], times: &Times) -> Option<u64> {
    let mut newest: Option<u64> = None;
    for n in nodes.iter_mut() {
        if let Some(s) = times.get(&n.path) {
            n.created_ms = Some(s.created);
            if !n.is_dir {
                n.modified_ms = Some(s.modified);
            }
        }
        if n.is_dir {
            n.modified_ms = assign(&mut n.children, times).or(n.created_ms);
        }
        newest = newest.max(n.modified_ms);
    }
    newest
}

/// 现在能否更新记录：正在同步时只读，免得把同步写入的文件当成修改、或与同步下来的 times.json 冲突
pub fn writable() -> bool {
    !webdav::busy() && !git::busy()
}

/// 用记录的时间替换扫描结果里的文件系统时间。`write` 为 true 时先按磁盘现状更新记录并保存。
pub fn apply(root: &Path, nodes: &mut [TreeNode], write: bool) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| "时间记录状态异常".to_string())?;
    let mut times = load(root)?;
    let mut result = Ok(());
    if write {
        let before = times.clone();
        reconcile(root, nodes, &mut times);
        if times != before {
            result = save(root, &times).map_err(|e| format!("保存文件时间记录失败：{e}"));
        }
    }
    assign(nodes, &times);
    result
}

/// 改名或移动之后把记录（文件夹连同其中各项）搬到新路径
pub fn relocate(root: &Path, from: &str, to: &str) -> Result<(), String> {
    if from == to {
        return Ok(());
    }
    let _guard = LOCK.lock().map_err(|_| "时间记录状态异常".to_string())?;
    let mut times = load(root)?;
    let prefix = format!("{from}/");
    let moved: Vec<String> = times.keys().filter(|k| *k == from || k.starts_with(&prefix)).cloned().collect();
    if moved.is_empty() {
        return Ok(());
    }
    for key in moved {
        if let Some(stamp) = times.remove(&key) {
            times.insert(format!("{to}{}", &key[from.len()..]), stamp);
        }
    }
    save(root, &times)
}

/// 删除（移进回收站）之后去掉记录，以后同名的新文件不会沿用旧的创建时间
pub fn forget(root: &Path, path: &str) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| "时间记录状态异常".to_string())?;
    let mut times = load(root)?;
    let prefix = format!("{path}/");
    let before = times.len();
    times.retain(|k, _| k != path && !k.starts_with(&prefix));
    if times.len() == before {
        return Ok(());
    }
    save(root, &times)
}

/// 笔记的创建时间（打开笔记时显示）；还没有记录时返回 None
pub fn created_of(root: &Path, rel: &str) -> Option<u64> {
    load(root).ok()?.get(rel).map(|s| s.created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn touch(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn set_mtime(path: &Path, ms: u64) {
        fs::File::options().write(true).open(path).unwrap().set_modified(UNIX_EPOCH + Duration::from_millis(ms)).unwrap();
    }

    fn stamp(created: u64, modified: u64, hash: &str) -> Stamp {
        Stamp { created, modified, hash: hash.into() }
    }

    fn scan(root: &Path) -> Vec<TreeNode> {
        let mut nodes = vault::scan(root).unwrap();
        apply(root, &mut nodes, true).unwrap();
        nodes
    }

    fn find<'a>(nodes: &'a [TreeNode], path: &str) -> &'a TreeNode {
        let mut all = Vec::new();
        flatten(nodes, &mut all);
        all.into_iter().find(|n| n.path == path).unwrap()
    }

    #[test]
    fn merge_keeps_earliest_created_and_latest_modified() {
        let a = stamp(100, 500, "a");
        let b = stamp(80, 400, "b");
        assert_eq!(merge_stamp(&a, &b), stamp(80, 500, "a"));
        assert_eq!(merge_stamp(&b, &a), stamp(80, 500, "a"));
        assert_eq!(merge_stamp(&stamp(0, 1, ""), &stamp(9, 2, "x")), stamp(9, 2, "x"));
    }

    #[test]
    fn serialize_one_entry_per_line_and_round_trip() {
        let mut t = Times::new();
        t.insert("b.md".into(), stamp(1, 2, "h"));
        t.insert("a".into(), stamp(3, 3, ""));
        let text = serialize(&t);
        assert_eq!(text, "{\n  \"a\": {\"created\":3,\"modified\":3},\n  \"b.md\": {\"created\":1,\"modified\":2,\"hash\":\"h\"}\n}\n");
        assert_eq!(parse(&text), t);
        assert_eq!(parse(""), Times::new());
    }

    #[test]
    fn parse_survives_git_conflict_markers() {
        let text = "{\n  \"a.md\": {\"created\":5,\"modified\":10,\"hash\":\"x\"},\n<<<<<<< HEAD\n  \"b.md\": {\"created\":7,\"modified\":20,\"hash\":\"ours\"}\n=======\n  \"b.md\": {\"created\":6,\"modified\":30,\"hash\":\"theirs\"},\n  \"c.md\": {\"created\":1,\"modified\":1,\"hash\":\"c\"}\n>>>>>>> origin/main\n}\n";
        let t = parse(text);
        assert_eq!(t.len(), 3);
        assert_eq!(t["b.md"], stamp(6, 30, "theirs"));
        let merged = parse(&merge_text(&serialize(&t), "{\n  \"a.md\": {\"created\":4,\"modified\":9,\"hash\":\"y\"}\n}\n"));
        assert_eq!(merged["a.md"], stamp(4, 10, "x"));
    }

    #[test]
    fn front_matter_created_date_and_time() {
        let day = front_matter_created("---\ntags: [a]\ncreated: 2026-09-01\n---\n正文").unwrap();
        let at = front_matter_created("---\ncreated: \"2026-09-01 10:20\"\n---\n").unwrap();
        assert_eq!(at - day, (10 * 60 + 20) * 60 * 1000);
        assert!(front_matter_created("created: 2026-09-01\n").is_none());
        assert!(front_matter_created("---\ntitle: x\n---\ncreated: 2026-09-01\n").is_none());
    }

    #[test]
    fn records_survive_rewrite_with_same_content_and_follow_real_edits() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("d/a.md"), "a\n");
        set_mtime(&root.join("d/a.md"), 1_000_000);
        let nodes = scan(root);
        assert_eq!(find(&nodes, "d/a.md").modified_ms, Some(1_000_000));
        assert!(root.join(REL).exists());

        // 同步下载：内容不变，文件时间变成写入那一刻，修改时间不受影响
        touch(&root.join("d/a.md"), "a\n");
        set_mtime(&root.join("d/a.md"), 9_000_000);
        let nodes = scan(root);
        assert_eq!(find(&nodes, "d/a.md").modified_ms, Some(1_000_000));

        // 真的改了内容
        touch(&root.join("d/a.md"), "b\n");
        set_mtime(&root.join("d/a.md"), 9_500_000);
        let nodes = scan(root);
        let a = find(&nodes, "d/a.md");
        assert_eq!(a.modified_ms, Some(9_500_000));
        assert!(a.created_ms.unwrap() <= 1_000_000);
        // 文件夹的修改时间取其中最新的
        assert_eq!(find(&nodes, "d").modified_ms, Some(9_500_000));
    }

    #[test]
    fn adopts_front_matter_created_and_prunes_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("n.md"), "---\ncreated: 2020-01-02\n---\nx\n");
        touch(&root.join("gone.md"), "x");
        scan(root);
        fs::remove_file(root.join("gone.md")).unwrap();
        let nodes = scan(root);
        let expected = parse_local_time("2020-01-02").unwrap();
        assert_eq!(find(&nodes, "n.md").created_ms, Some(expected));
        assert!(!load(root).unwrap().contains_key("gone.md"));
    }

    #[test]
    fn read_only_apply_never_writes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("a.md"), "a");
        let mut nodes = vault::scan(root).unwrap();
        apply(root, &mut nodes, false).unwrap();
        assert!(!root.join(REL).exists());
    }

    #[test]
    fn relocate_and_forget_follow_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mut t = Times::new();
        t.insert("d".into(), stamp(1, 1, ""));
        t.insert("d/a.md".into(), stamp(2, 3, "h"));
        t.insert("dx.md".into(), stamp(4, 4, "k"));
        save(root, &t).unwrap();
        relocate(root, "d", "e/d").unwrap();
        let t = load(root).unwrap();
        assert_eq!(t.keys().cloned().collect::<Vec<_>>(), ["dx.md", "e/d", "e/d/a.md"]);
        forget(root, "e/d").unwrap();
        assert_eq!(load(root).unwrap().keys().cloned().collect::<Vec<_>>(), ["dx.md"]);
        assert_eq!(created_of(root, "dx.md"), Some(4));
    }
}
