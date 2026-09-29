//! 笔记库内的文件操作：新建、重命名、移动、移入回收站、附件、笔记库配置。
//! 笔记的附件目录 `笔记名.assets/` 始终跟随笔记一起重命名、移动和删除。

use crate::vault::{atomic_write, rel_of, resolve, resolve_dir};
use serde::Serialize;
use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const INVALID_CHARS: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 校验用户输入的名称（不含扩展名），返回去掉首尾空白后的名称
pub fn validate_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("名称不能为空".into());
    }
    if let Some(c) = n.chars().find(|c| INVALID_CHARS.contains(c) || c.is_control()) {
        return Err(format!("名称不能包含字符 {c:?}"));
    }
    if n.starts_with('.') {
        return Err("名称不能以 . 开头".into());
    }
    if n.ends_with('.') {
        return Err("名称不能以 . 结尾".into());
    }
    let stem = n.split('.').next().unwrap_or(n).to_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return Err(format!("{n} 是系统保留名称"));
    }
    if n.chars().count() > 200 {
        return Err("名称过长".into());
    }
    Ok(n.to_string())
}

fn io_err(ctx: &str, path: &Path, e: std::io::Error) -> String {
    format!("{ctx} {}：{e}", path.display())
}

/// 在目录下找一个不重名的路径：`名称.ext`、`名称 1.ext`、`名称 2.ext`……
fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}{ext}"));
    if !first.exists() {
        return first;
    }
    (1..)
        .map(|i| dir.join(format!("{stem} {i}{ext}")))
        .find(|p| !p.exists())
        .expect("unbounded range")
}

fn note_stem(note: &Path) -> String {
    let name = note.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    match name.len() {
        n if n > 3 && name.to_lowercase().ends_with(".md") => name[..n - 3].to_string(),
        _ => name,
    }
}

pub fn assets_dir(note: &Path) -> PathBuf {
    note.with_file_name(format!("{}.assets", note_stem(note)))
}

fn same_path_ignoring_case(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

fn require_dir(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        Ok(())
    } else {
        Err(format!("文件夹不存在：{}", path.display()))
    }
}

pub fn create_note(root: &Path, dir_rel: &str, name: Option<&str>) -> Result<String, String> {
    let dir = resolve_dir(root, dir_rel)?;
    require_dir(&dir)?;
    let stem = validate_name(name.unwrap_or("未命名"))?;
    let path = unique_path(&dir, &stem, ".md");
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| io_err("新建笔记失败", &path, e))?;
    rel_of(root, &path)
}

pub fn create_folder(root: &Path, dir_rel: &str, name: Option<&str>) -> Result<String, String> {
    let dir = resolve_dir(root, dir_rel)?;
    require_dir(&dir)?;
    let stem = validate_name(name.unwrap_or("新建文件夹"))?;
    if stem.ends_with(".assets") {
        return Err("文件夹名不能以 .assets 结尾（该后缀保留给附件目录）".into());
    }
    let path = unique_path(&dir, &stem, "");
    fs::create_dir(&path).map_err(|e| io_err("新建文件夹失败", &path, e))?;
    rel_of(root, &path)
}

/// 把 `from` 替换为 `to`，只替换前面是路径边界的出现位置，避免把 `ab.assets/` 误当成 `b.assets/`
fn replace_bounded(text: &str, from: &str, to: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut prev: Option<char> = None;
    while let Some(i) = rest.find(from) {
        let before = rest[..i].chars().last().or(if i == 0 { prev } else { None });
        let boundary = matches!(before, None | Some('(' | '<' | '/' | '"' | '\'' | ' ' | '\t' | '\n' | '\r' | '['));
        out.push_str(&rest[..i]);
        out.push_str(if boundary { to } else { from });
        prev = from.chars().last();
        rest = &rest[i + from.len()..];
    }
    out.push_str(rest);
    out
}

/// 笔记改名后，把正文里对旧附件目录的引用改成新目录
pub fn rewrite_asset_refs(content: &str, old_stem: &str, new_stem: &str) -> String {
    let mut out = replace_bounded(content, &format!("{old_stem}.assets/"), &format!("{new_stem}.assets/"));
    let enc = |s: &str| s.replace(' ', "%20");
    if old_stem.contains(' ') {
        out = replace_bounded(&out, &format!("{}.assets/", enc(old_stem)), &format!("{}.assets/", enc(new_stem)));
    }
    out
}

/// 移动或重命名笔记文件，并带上它的附件目录；附件目录移动失败时把笔记移回原处
fn move_note(src: &Path, dst: &Path) -> Result<(), String> {
    let src_assets = assets_dir(src);
    let dst_assets = assets_dir(dst);
    let has_assets = src_assets.is_dir();
    if has_assets && dst_assets.exists() && !same_path_ignoring_case(&src_assets, &dst_assets) {
        return Err(format!("目标位置已存在附件目录：{}", dst_assets.display()));
    }
    fs::rename(src, dst).map_err(|e| io_err("移动笔记失败", src, e))?;
    if has_assets {
        if let Err(e) = fs::rename(&src_assets, &dst_assets) {
            let rollback = fs::rename(dst, src);
            return Err(format!(
                "移动附件目录失败 {}：{e}{}",
                src_assets.display(),
                if rollback.is_err() { "（笔记已移动，回滚失败）" } else { "（笔记已还原）" }
            ));
        }
    }
    Ok(())
}

pub fn rename_entry(root: &Path, rel: &str, new_name: &str) -> Result<String, String> {
    let src = resolve(root, rel)?;
    let meta = fs::metadata(&src).map_err(|e| io_err("读取失败", &src, e))?;
    let name = validate_name(new_name)?;
    let parent = src.parent().ok_or("无效路径")?;
    if meta.is_dir() {
        if name.ends_with(".assets") {
            return Err("文件夹名不能以 .assets 结尾（该后缀保留给附件目录）".into());
        }
        let dst = parent.join(&name);
        if dst == src {
            return Ok(rel.to_string());
        }
        if dst.exists() && !same_path_ignoring_case(&src, &dst) {
            return Err(format!("已存在同名文件夹：{name}"));
        }
        fs::rename(&src, &dst).map_err(|e| io_err("重命名失败", &src, e))?;
        return rel_of(root, &dst);
    }

    let dst = parent.join(format!("{name}.md"));
    if dst == src {
        return Ok(rel.to_string());
    }
    if dst.exists() && !same_path_ignoring_case(&src, &dst) {
        return Err(format!("已存在同名笔记：{name}"));
    }
    let old_stem = note_stem(&src);
    let had_assets = assets_dir(&src).is_dir();
    move_note(&src, &dst)?;
    if had_assets {
        let content = fs::read_to_string(&dst).map_err(|e| io_err("读取笔记失败", &dst, e))?;
        let updated = rewrite_asset_refs(&content, &old_stem, &name);
        if updated != content {
            atomic_write(&dst, &updated).map_err(|e| format!("笔记已重命名，但更新附件引用失败：{e}"))?;
        }
    }
    rel_of(root, &dst)
}

pub fn move_entry(root: &Path, rel: &str, target_dir_rel: &str) -> Result<String, String> {
    let src = resolve(root, rel)?;
    let dir = resolve_dir(root, target_dir_rel)?;
    require_dir(&dir)?;
    let meta = fs::metadata(&src).map_err(|e| io_err("读取失败", &src, e))?;
    let file_name = src.file_name().ok_or("无效路径")?;
    let dst = dir.join(file_name);
    if dst == src {
        return Ok(rel.to_string());
    }
    if meta.is_dir() && dir.starts_with(&src) {
        return Err("不能把文件夹移动到它自己或它的子文件夹里".into());
    }
    if dst.exists() {
        return Err(format!("目标文件夹里已有同名项：{}", file_name.to_string_lossy()));
    }
    if meta.is_dir() {
        fs::rename(&src, &dst).map_err(|e| io_err("移动文件夹失败", &src, e))?;
    } else {
        move_note(&src, &dst)?;
    }
    rel_of(root, &dst)
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// 移入 `.ttnote/trash/<时间戳>/`，保留原相对路径，并写入 meta.json 供之后恢复
pub fn trash_entry(root: &Path, rel: &str) -> Result<(), String> {
    let src = resolve(root, rel)?;
    let meta = fs::metadata(&src).map_err(|e| io_err("读取失败", &src, e))?;
    let trash_root = root.join(".ttnote").join("trash");
    let stamp = now_ms();
    let bucket = unique_path(&trash_root, &stamp.to_string(), "");
    let dst = bucket.join(Path::new(rel));
    let dst_parent = dst.parent().ok_or("无效路径")?;
    fs::create_dir_all(dst_parent).map_err(|e| io_err("创建回收站目录失败", dst_parent, e))?;
    if meta.is_dir() {
        fs::rename(&src, &dst).map_err(|e| io_err("移入回收站失败", &src, e))?;
    } else {
        move_note(&src, &dst)?;
    }
    let info = json!({ "originalPath": rel, "deletedAt": stamp as u64, "isDir": meta.is_dir() });
    atomic_write(&bucket.join("meta.json"), &info.to_string())
        .map_err(|e| format!("已移入回收站，但记录原位置失败：{e}"))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    pub original_path: String,
    pub name: String,
    pub deleted_at: u64,
    pub is_dir: bool,
}

fn valid_bucket_id(id: &str) -> bool {
    !id.is_empty() && id != "." && id != ".." && !id.contains(['/', '\\']) && id.chars().all(|c| c.is_ascii_digit() || c == ' ')
}

fn trash_root(root: &Path) -> PathBuf {
    root.join(".ttnote").join("trash")
}

fn bucket_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_bucket_id(id) {
        return Err("无效的回收站记录".into());
    }
    let path = trash_root(root).join(id);
    if !path.is_dir() {
        return Err("回收站里没有这项".into());
    }
    Ok(path)
}

fn read_meta(bucket: &Path) -> Result<serde_json::Value, String> {
    let raw = fs::read_to_string(bucket.join("meta.json")).map_err(|e| format!("读取回收站记录失败：{e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("回收站记录损坏：{e}"))
}

fn item_name(path: &str, is_dir: bool) -> String {
    let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
    if !is_dir && file.len() > 3 && file.to_ascii_lowercase().ends_with(".md") {
        file[..file.len() - 3].to_string()
    } else {
        file.to_string()
    }
}

pub fn trash_list(root: &Path) -> Result<Vec<TrashItem>, String> {
    let base = trash_root(root);
    let Ok(entries) = fs::read_dir(&base) else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取回收站失败：{e}"))?;
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        let Ok(meta) = read_meta(&entry.path()) else { continue };
        let original_path = meta["originalPath"].as_str().unwrap_or("").to_string();
        if original_path.is_empty() {
            continue;
        }
        let is_dir = meta["isDir"].as_bool().unwrap_or(false);
        let deleted_at = meta["deletedAt"].as_u64().unwrap_or(0);
        out.push(TrashItem { name: item_name(&original_path, is_dir), id, original_path, deleted_at, is_dir });
    }
    out.sort_by_key(|t| std::cmp::Reverse(t.deleted_at));
    Ok(out)
}

pub fn trash_restore(root: &Path, id: &str) -> Result<(), String> {
    let bucket = bucket_dir(root, id)?;
    let meta = read_meta(&bucket)?;
    let rel = meta["originalPath"].as_str().ok_or("回收站记录缺少原位置")?;
    let is_dir = meta["isDir"].as_bool().unwrap_or(false);
    let dst = resolve(root, rel)?;
    if dst.exists() {
        return Err(format!("原位置已有同名项：{rel}"));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err("创建原目录失败", parent, e))?;
    }
    let src = bucket.join(Path::new(rel));
    if is_dir {
        fs::rename(&src, &dst).map_err(|e| io_err("恢复失败", &src, e))?;
    } else {
        move_note(&src, &dst)?;
    }
    fs::remove_dir_all(&bucket).map_err(|e| format!("已恢复，但清理回收站记录失败：{e}"))?;
    Ok(())
}

pub fn trash_delete(root: &Path, id: &str) -> Result<(), String> {
    let bucket = bucket_dir(root, id)?;
    fs::remove_dir_all(&bucket).map_err(|e| format!("彻底删除失败：{e}"))
}

pub fn trash_empty(root: &Path) -> Result<(), String> {
    let base = trash_root(root);
    let Ok(entries) = fs::read_dir(&base) else { return Ok(()) };
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            fs::remove_dir_all(entry.path()).map_err(|e| format!("清空回收站失败：{e}"))?;
        }
    }
    Ok(())
}

/// `days == 0` 时不清理。
pub fn trash_prune(root: &Path, days: u32) -> Result<(), String> {
    if days == 0 {
        return Ok(());
    }
    let cutoff = now_ms().saturating_sub(days as u128 * 24 * 60 * 60 * 1000);
    for item in trash_list(root)? {
        if (item.deleted_at as u128) < cutoff {
            trash_delete(root, &item.id)?;
        }
    }
    Ok(())
}

fn split_ext(file_name: &str) -> (String, String) {
    match file_name.rfind('.') {
        Some(i) if i > 0 => (file_name[..i].to_string(), file_name[i..].to_string()),
        _ => (file_name.to_string(), String::new()),
    }
}

/// 保存附件到笔记的附件目录，返回相对笔记所在目录的引用路径，如 `周报.assets/image.png`
pub fn save_attachment(root: &Path, note_rel: &str, file_name: &str, bytes: &[u8]) -> Result<String, String> {
    let note = resolve(root, note_rel)?;
    let dir = assets_dir(&note);
    fs::create_dir_all(&dir).map_err(|e| io_err("创建附件目录失败", &dir, e))?;
    let (stem, ext) = split_ext(file_name.trim());
    let stem = validate_name(&stem).unwrap_or_else(|_| "attachment".into());
    let ext: String = ext.chars().filter(|c| !INVALID_CHARS.contains(c) && !c.is_control()).collect();
    let path = unique_path(&dir, &stem, &ext);
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| io_err("保存附件失败", &path, e))?;
    f.write_all(bytes).and_then(|_| f.sync_all()).map_err(|e| {
        let _ = fs::remove_file(&path);
        io_err("保存附件失败", &path, e)
    })?;
    let file = path.file_name().ok_or("无效路径")?.to_string_lossy();
    Ok(format!("{}.assets/{file}", note_stem(&note)))
}

pub fn import_attachment(root: &Path, note_rel: &str, source: &str) -> Result<String, String> {
    let src = Path::new(source);
    let bytes = fs::read(src).map_err(|e| io_err("读取文件失败", src, e))?;
    let name = src.file_name().ok_or("无效文件路径")?.to_string_lossy().into_owned();
    save_attachment(root, note_rel, &name, &bytes)
}

fn config_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) || name.starts_with('.') {
        return Err(format!("非法配置名：{name}"));
    }
    Ok(root.join(".ttnote").join("config").join(name))
}

/// 读取笔记库配置（`.ttnote/config/<name>`），不存在时返回 None
pub fn config_read(root: &Path, name: &str) -> Result<Option<String>, String> {
    let path = config_path(root, name)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_err("读取配置失败", &path, e)),
    }
}

pub fn config_write(root: &Path, name: &str, content: &str) -> Result<(), String> {
    let path = config_path(root, name)?;
    let dir = path.parent().ok_or("无效路径")?;
    fs::create_dir_all(dir).map_err(|e| io_err("创建配置目录失败", dir, e))?;
    atomic_write(&path, content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn validate_rejects_bad_names() {
        for bad in ["", "  ", "a/b", "a\\b", "a:b", "a?b", ".hidden", "end.", "CON", "nul.txt"] {
            assert!(validate_name(bad).is_err(), "{bad:?} should be rejected");
        }
        assert_eq!(validate_name("  周报 1 ").unwrap(), "周报 1");
    }

    #[test]
    fn create_note_and_folder_pick_unique_names() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert_eq!(create_note(root, "", None).unwrap(), "未命名.md");
        assert_eq!(create_note(root, "", None).unwrap(), "未命名 1.md");
        assert_eq!(create_folder(root, "", None).unwrap(), "新建文件夹");
        assert_eq!(create_note(root, "新建文件夹", Some("周报")).unwrap(), "新建文件夹/周报.md");
        assert!(create_note(root, "missing", None).is_err());
        assert!(create_folder(root, "", Some("x.assets")).is_err());
    }

    #[test]
    fn rename_note_moves_assets_and_rewrites_refs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("d/old name.md"), "![](<old name.assets/a.png>) ![](old%20name.assets/b.png) xold name.assets/ keep\n");
        touch(&root.join("d/old name.assets/a.png"), "img");
        let rel = rename_entry(root, "d/old name.md", "新 名").unwrap();
        assert_eq!(rel, "d/新 名.md");
        assert!(!root.join("d/old name.md").exists());
        assert!(root.join("d/新 名.assets/a.png").exists());
        let content = fs::read_to_string(root.join("d/新 名.md")).unwrap();
        assert_eq!(content, "![](<新 名.assets/a.png>) ![](新%20名.assets/b.png) xold name.assets/ keep\n");
    }

    #[test]
    fn rename_conflict_and_case_only() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("a.md"), "a");
        touch(&root.join("b.md"), "b");
        assert!(rename_entry(root, "a.md", "b").unwrap_err().contains("已存在"));
        assert_eq!(rename_entry(root, "a.md", "A").unwrap(), "A.md");
        assert_eq!(fs::read_to_string(root.join("A.md")).unwrap(), "a");
    }

    #[test]
    fn move_note_with_assets_and_reject_bad_targets() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("n.md"), "![](n.assets/x.png)");
        touch(&root.join("n.assets/x.png"), "x");
        fs::create_dir_all(root.join("dst/sub")).unwrap();
        assert_eq!(move_entry(root, "n.md", "dst").unwrap(), "dst/n.md");
        assert!(root.join("dst/n.assets/x.png").exists());
        assert!(!root.join("n.assets").exists());
        assert!(move_entry(root, "dst", "dst/sub").is_err());
        touch(&root.join("n.md"), "again");
        assert!(move_entry(root, "n.md", "dst").unwrap_err().contains("同名"));
        assert_eq!(move_entry(root, "dst/sub", "").unwrap(), "sub");
    }

    #[test]
    fn trash_keeps_relative_path_and_meta() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("d/n.md"), "n");
        touch(&root.join("d/n.assets/x.png"), "x");
        trash_entry(root, "d/n.md").unwrap();
        assert!(!root.join("d/n.md").exists());
        assert!(!root.join("d/n.assets").exists());
        let bucket = fs::read_dir(root.join(".ttnote/trash")).unwrap().next().unwrap().unwrap().path();
        assert_eq!(fs::read_to_string(bucket.join("d/n.md")).unwrap(), "n");
        assert!(bucket.join("d/n.assets/x.png").exists());
        let meta: serde_json::Value = serde_json::from_str(&fs::read_to_string(bucket.join("meta.json")).unwrap()).unwrap();
        assert_eq!(meta["originalPath"], "d/n.md");
        let items = trash_list(root).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "n");
        trash_restore(root, &items[0].id).unwrap();
        assert_eq!(fs::read_to_string(root.join("d/n.md")).unwrap(), "n");
        assert!(root.join("d/n.assets/x.png").exists());
        assert!(trash_list(root).unwrap().is_empty());
    }

    #[test]
    fn attachments_go_to_note_assets_with_unique_names() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("d/周报.md"), "");
        assert_eq!(save_attachment(root, "d/周报.md", "image.png", b"1").unwrap(), "周报.assets/image.png");
        assert_eq!(save_attachment(root, "d/周报.md", "image.png", b"2").unwrap(), "周报.assets/image 1.png");
        assert_eq!(save_attachment(root, "d/周报.md", "a:b.png", b"3").unwrap(), "周报.assets/attachment.png");
        assert_eq!(fs::read(root.join("d/周报.assets/image 1.png")).unwrap(), b"2");
    }

    #[test]
    fn config_roundtrip_and_name_check() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert_eq!(config_read(root, "order.json").unwrap(), None);
        config_write(root, "order.json", "{}").unwrap();
        assert_eq!(config_read(root, "order.json").unwrap().as_deref(), Some("{}"));
        assert!(config_read(root, "../x").is_err());
    }
}
