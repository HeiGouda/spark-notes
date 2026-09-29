use serde::Serialize;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    /// 相对笔记库根目录的路径，统一用 `/` 分隔
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<TreeNode>,
    pub modified_ms: Option<u64>,
    pub created_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFile {
    pub content: String,
    /// 文件创建时间（毫秒时间戳），平台不支持时退回修改时间
    pub created_ms: Option<u64>,
}

/// 把前端传来的相对路径解析到笔记库内，拒绝绝对路径和 `..`，防止越出笔记库。
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel.is_empty() {
        return Err("路径为空".into());
    }
    for c in rel_path.components() {
        match c {
            Component::Normal(_) => {}
            _ => return Err(format!("非法路径：{rel}")),
        }
    }
    Ok(root.join(rel_path))
}

/// 同 `resolve`，但允许空字符串表示笔记库根目录
pub fn resolve_dir(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        Ok(root.to_path_buf())
    } else {
        resolve(root, rel)
    }
}

/// 笔记库内绝对路径转回 `/` 分隔的相对路径
pub fn rel_of(root: &Path, path: &Path) -> Result<String, String> {
    Ok(path
        .strip_prefix(root)
        .map_err(|_| format!("路径不在笔记库内：{}", path.display()))?
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn to_ms(t: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

fn is_hidden_entry(name: &str, is_dir: bool) -> bool {
    name.starts_with('.') || (is_dir && name.ends_with(".assets"))
}

fn scan_dir(root: &Path, dir: &Path) -> Result<Vec<TreeNode>, String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("读取目录失败 {}：{e}", dir.display()))?;
    let mut nodes = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败 {}：{e}", dir.display()))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取文件类型失败 {}：{e}", entry.path().display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = file_type.is_dir();
        if is_hidden_entry(&name, is_dir) {
            continue;
        }
        let full = entry.path();
        let rel = rel_of(root, &full)?;
        let (modified_ms, created_ms) = match entry.metadata() {
            Ok(m) => (to_ms(m.modified()), to_ms(m.created())),
            Err(_) => (None, None),
        };
        if is_dir {
            nodes.push(TreeNode {
                name,
                path: rel,
                is_dir: true,
                children: scan_dir(root, &full)?,
                modified_ms,
                created_ms,
            });
        } else if file_type.is_file() && name.to_lowercase().ends_with(".md") {
            nodes.push(TreeNode {
                name: name[..name.len() - 3].to_string(),
                path: rel,
                is_dir: false,
                children: Vec::new(),
                modified_ms,
                created_ms,
            });
        }
    }
    nodes.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(nodes)
}

pub fn scan(root: &Path) -> Result<Vec<TreeNode>, String> {
    if !root.is_dir() {
        return Err(format!("笔记库目录不存在：{}", root.display()));
    }
    scan_dir(root, root)
}

pub fn read_note(root: &Path, rel: &str) -> Result<NoteFile, String> {
    let path = resolve(root, rel)?;
    let content = fs::read_to_string(&path).map_err(|e| format!("读取笔记失败 {rel}：{e}"))?;
    let meta = fs::metadata(&path).map_err(|e| format!("读取文件信息失败 {rel}：{e}"))?;
    let created_ms = to_ms(meta.created()).or_else(|| to_ms(meta.modified()));
    Ok(NoteFile { content, created_ms })
}

/// 先写同目录下的临时文件并落盘，再重命名覆盖目标，避免写到一半断电导致笔记损坏。
pub fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    atomic_write_bytes(path, content.as_bytes())
}

/// 与 `atomic_write` 相同，用于图片等二进制文件
pub fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or_else(|| format!("无效路径：{}", path.display()))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("无效路径：{}", path.display()))?
        .to_string_lossy();
    let tmp = dir.join(format!(".{file_name}.ttnote-tmp"));
    let result = (|| {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("保存失败 {}：{e}", path.display()));
    }
    Ok(())
}

pub fn write_note(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    let path = resolve(root, rel)?;
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
    fn scan_lists_md_and_dirs_and_hides_internal_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("工作/周报.md"), "a");
        touch(&root.join("工作/周报.assets/img.png"), "x");
        touch(&root.join(".ttnote/cache/index.db"), "x");
        touch(&root.join("b.md"), "b");
        touch(&root.join("a.MD"), "a");
        touch(&root.join("readme.txt"), "t");

        let tree = scan(root).unwrap();
        let names: Vec<_> = tree.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["工作", "a", "b"]);
        assert!(tree[0].is_dir);
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].path, "工作/周报.md");
        assert_eq!(tree[0].children[0].name, "周报");
    }

    #[test]
    fn scan_missing_root_is_error() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(scan(&tmp.path().join("nope")).is_err());
    }

    #[test]
    fn resolve_rejects_escape() {
        let root = Path::new("C:/vault");
        assert!(resolve(root, "../x.md").is_err());
        assert!(resolve(root, "a/../../x.md").is_err());
        assert!(resolve(root, "C:/Windows/x.md").is_err());
        assert!(resolve(root, "/etc/x.md").is_err());
        assert!(resolve(root, "").is_err());
        assert_eq!(resolve(root, "a/b.md").unwrap(), root.join("a/b.md"));
    }

    #[test]
    fn write_then_read_roundtrip_overwrites_and_leaves_no_tmp() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("n.md"), "old");
        write_note(root, "n.md", "新内容\n").unwrap();
        let note = read_note(root, "n.md").unwrap();
        assert_eq!(note.content, "新内容\n");
        assert!(note.created_ms.is_some());
        let leftovers: Vec<_> = fs::read_dir(root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".ttnote-tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn write_into_missing_dir_fails_without_creating_file() {
        let tmp = tempfile::tempdir().unwrap();
        let err = write_note(tmp.path(), "missing/n.md", "x").unwrap_err();
        assert!(err.contains("保存失败"));
        assert!(!tmp.path().join("missing").exists());
    }
}
