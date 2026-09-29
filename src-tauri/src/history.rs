//! 笔记的本地历史快照。保存在 `.ttnote/history/`，不参与同步。
//! 同一篇笔记 5 分钟内最多一份；快照的是这次保存之前的内容。

use crate::fsops;
use crate::vault::{self, atomic_write};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const THROTTLE_MS: u64 = 5 * 60 * 1000;
const DEFAULT_DAYS: u32 = 30;
const PRUNE_INTERVAL_MS: u64 = 60 * 60 * 1000;
static LAST_PRUNE_MS: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryVersion {
    pub id: String,
    pub time_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn note_key(rel: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in rel.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn history_root(root: &Path) -> PathBuf {
    root.join(".ttnote").join("history")
}

fn note_dir(root: &Path, rel: &str) -> PathBuf {
    history_root(root).join(note_key(rel))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_digit())
}

/// 历史版本与回收站的保留天数。0 表示不自动清理。
pub fn retention_days(root: &Path) -> (u32, u32) {
    let raw = fsops::config_read(root, "retention.json").ok().flatten();
    let Some(raw) = raw else { return (DEFAULT_DAYS, DEFAULT_DAYS) };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { return (DEFAULT_DAYS, DEFAULT_DAYS) };
    (day_field(&v, "historyDays"), day_field(&v, "trashDays"))
}

fn day_field(v: &serde_json::Value, key: &str) -> u32 {
    match v.get(key).and_then(|x| x.as_u64()) {
        Some(n) => n.min(3650) as u32,
        None => DEFAULT_DAYS,
    }
}

fn latest_ms(dir: &Path) -> Option<u64> {
    fs::read_dir(dir).ok()?.filter_map(|e| e.ok()).filter_map(|e| version_ms(&e.file_name().to_string_lossy())).max()
}

fn version_ms(name: &str) -> Option<u64> {
    let stem = name.strip_suffix(".md")?;
    if !valid_id(stem) { return None }
    stem.parse().ok()
}

/// 在覆盖笔记之前调用。内容没变、或 5 分钟内已有快照时什么都不写。
pub fn before_write(root: &Path, rel: &str, new_content: &str) -> Result<(), String> {
    let path = vault::resolve(root, rel)?;
    let old = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("读取笔记失败 {}：{e}", path.display())),
    };
    if old == new_content {
        return Ok(());
    }
    write_snapshot(root, rel, &old, false)?;
    // 清理要遍历整个历史目录，自动保存很频繁，每小时最多清理一次
    let now = now_ms();
    let last = LAST_PRUNE_MS.load(Ordering::Relaxed);
    if now.saturating_sub(last) >= PRUNE_INTERVAL_MS
        && LAST_PRUNE_MS.compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed).is_ok()
    {
        let (days, _) = retention_days(root);
        prune(root, days)?;
    }
    Ok(())
}

fn write_snapshot(root: &Path, rel: &str, content: &str, force: bool) -> Result<(), String> {
    let dir = note_dir(root, rel);
    if !force {
        if let Some(prev) = latest_ms(&dir) {
            if now_ms().saturating_sub(prev) < THROTTLE_MS {
                return Ok(());
            }
        }
    }
    fs::create_dir_all(&dir).map_err(|e| format!("创建历史目录失败：{e}"))?;
    let marker = dir.join("path.txt");
    if !marker.exists() {
        atomic_write(&marker, rel)?;
    }
    let mut stamp = now_ms();
    let mut dest = dir.join(format!("{stamp}.md"));
    while dest.exists() {
        stamp += 1;
        dest = dir.join(format!("{stamp}.md"));
    }
    atomic_write(&dest, content)
}

pub fn list(root: &Path, rel: &str) -> Result<Vec<HistoryVersion>, String> {
    let (days, _) = retention_days(root);
    prune(root, days)?;
    let dir = note_dir(root, rel);
    let Ok(entries) = fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取历史版本失败：{e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(time_ms) = version_ms(&name) else { continue };
        out.push(HistoryVersion { id: time_ms.to_string(), time_ms });
    }
    out.sort_by_key(|v| std::cmp::Reverse(v.time_ms));
    Ok(out)
}

pub fn read(root: &Path, rel: &str, id: &str) -> Result<String, String> {
    if !valid_id(id) {
        return Err("无效的历史版本".into());
    }
    let path = note_dir(root, rel).join(format!("{id}.md"));
    fs::read_to_string(&path).map_err(|e| format!("读取历史版本失败：{e}"))
}

/// 立即把磁盘上的当前内容存一份快照，不受 5 分钟节流限制（AI 整理结构替换前调用）
pub fn snapshot_now(root: &Path, rel: &str) -> Result<(), String> {
    let path = vault::resolve(root, rel)?;
    let current = fs::read_to_string(&path).map_err(|e| format!("读取笔记失败 {}：{e}", path.display()))?;
    write_snapshot(root, rel, &current, true)
}

/// 恢复到某个快照。恢复前先把当前内容强制存一份，避免覆盖后找不回来。
pub fn restore(root: &Path, rel: &str, id: &str) -> Result<(), String> {
    let snapshot = read(root, rel, id)?;
    let path = vault::resolve(root, rel)?;
    if let Ok(current) = fs::read_to_string(&path) {
        if current != snapshot {
            write_snapshot(root, rel, &current, true)?;
        }
    }
    vault::write_note(root, rel, &snapshot)
}

/// 笔记或文件夹从 `from` 改名 / 移动到 `to` 之后，把其中笔记的历史版本迁到新路径下
pub fn relocate(root: &Path, from: &str, to: &str) -> Result<(), String> {
    if from == to {
        return Ok(());
    }
    let Ok(dirs) = fs::read_dir(history_root(root)) else { return Ok(()) };
    for dir in dirs.flatten() {
        let old_dir = dir.path();
        let Ok(rel) = fs::read_to_string(old_dir.join("path.txt")) else { continue };
        let Some(rest) = rel.strip_prefix(from) else { continue };
        if !rest.is_empty() && !rest.starts_with('/') {
            continue;
        }
        let new_rel = format!("{to}{rest}");
        let new_dir = note_dir(root, &new_rel);
        if new_dir != old_dir {
            if new_dir.exists() {
                merge_versions(&old_dir, &new_dir)?;
            } else {
                fs::rename(&old_dir, &new_dir).map_err(|e| format!("迁移历史版本失败：{e}"))?;
            }
        }
        atomic_write(&new_dir.join("path.txt"), &new_rel)?;
    }
    Ok(())
}

/// 目标路径以前也有过历史（例如删掉的同名笔记），把版本文件并过去，同名的保留目标里的
fn merge_versions(from_dir: &Path, to_dir: &Path) -> Result<(), String> {
    let entries = fs::read_dir(from_dir).map_err(|e| format!("迁移历史版本失败：{e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if version_ms(&name.to_string_lossy()).is_none() {
            continue;
        }
        let dest = to_dir.join(&name);
        if !dest.exists() {
            fs::rename(entry.path(), &dest).map_err(|e| format!("迁移历史版本失败：{e}"))?;
        }
    }
    fs::remove_dir_all(from_dir).map_err(|e| format!("迁移历史版本失败：{e}"))
}

pub fn prune(root: &Path, days: u32) -> Result<(), String> {
    if days == 0 {
        return Ok(());
    }
    let base = history_root(root);
    let Ok(dirs) = fs::read_dir(&base) else { return Ok(()) };
    let cutoff = now_ms().saturating_sub(days as u64 * 24 * 60 * 60 * 1000);
    for dir in dirs.flatten() {
        if !dir.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let path = dir.path();
        if let Ok(files) = fs::read_dir(&path) {
            for file in files.flatten() {
                let name = file.file_name().to_string_lossy().into_owned();
                if let Some(ms) = version_ms(&name) {
                    if ms < cutoff {
                        let _ = fs::remove_file(file.path());
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_keeps_previous_and_throttles() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("周报.md"), "第一版\n").unwrap();
        before_write(root, "周报.md", "第二版\n").unwrap();
        vault::write_note(root, "周报.md", "第二版\n").unwrap();
        let versions = list(root, "周报.md").unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(read(root, "周报.md", &versions[0].id).unwrap(), "第一版\n");
        before_write(root, "周报.md", "第三版\n").unwrap();
        assert_eq!(list(root, "周报.md").unwrap().len(), 1);
    }

    #[test]
    fn restore_snapshots_the_current_text_first() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("a.md"), "旧\n").unwrap();
        before_write(root, "a.md", "新\n").unwrap();
        vault::write_note(root, "a.md", "新\n").unwrap();
        let id = list(root, "a.md").unwrap()[0].id.clone();
        restore(root, "a.md", &id).unwrap();
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "旧\n");
        let versions = list(root, "a.md").unwrap();
        assert!(versions.len() >= 2);
        assert_eq!(read(root, "a.md", &versions[0].id).unwrap(), "新\n");
    }

    #[test]
    fn relocate_follows_note_and_folder_moves() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("d")).unwrap();
        fs::write(root.join("d/a.md"), "旧\n").unwrap();
        before_write(root, "d/a.md", "新\n").unwrap();
        fs::write(root.join("dx.md"), "x\n").unwrap();
        before_write(root, "dx.md", "y\n").unwrap();

        relocate(root, "d/a.md", "d/b.md").unwrap();
        assert!(list(root, "d/a.md").unwrap().is_empty());
        let id = list(root, "d/b.md").unwrap()[0].id.clone();
        assert_eq!(read(root, "d/b.md", &id).unwrap(), "旧\n");

        relocate(root, "d", "e").unwrap();
        assert_eq!(list(root, "e/b.md").unwrap().len(), 1);
        assert_eq!(fs::read_to_string(note_dir(root, "e/b.md").join("path.txt")).unwrap(), "e/b.md");
        // 只是名字以 d 开头的笔记不受影响
        assert_eq!(list(root, "dx.md").unwrap().len(), 1);
    }

    #[test]
    fn relocate_merges_into_existing_history() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for (rel, ms) in [("a.md", now_ms()), ("b.md", now_ms() - 1000)] {
            let dir = note_dir(root, rel);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("path.txt"), rel).unwrap();
            fs::write(dir.join(format!("{ms}.md")), rel).unwrap();
        }
        relocate(root, "a.md", "b.md").unwrap();
        assert!(!note_dir(root, "a.md").exists());
        assert_eq!(list(root, "b.md").unwrap().len(), 2);
    }

    #[test]
    fn prune_drops_old_snapshots_only() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("a.md"), "现在\n").unwrap();
        let dir = note_dir(root, "a.md");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("path.txt"), "a.md").unwrap();
        fs::write(dir.join("1000.md"), "很久以前\n").unwrap();
        fs::write(dir.join(format!("{}.md", now_ms())), "最近\n").unwrap();
        prune(root, 30).unwrap();
        assert!(!dir.join("1000.md").exists());
        assert_eq!(list(root, "a.md").unwrap().len(), 1);
        prune(root, 0).unwrap();
    }
}
