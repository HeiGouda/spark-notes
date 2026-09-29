//! 把笔记库导出为 zip，或从 zip 导入为新笔记库。不含缓存、历史、回收站和同步状态。

use crate::webdav::should_sync;
use std::fs::{self, File};
use std::io;
use std::path::{Component, Path};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub fn export_zip(root: &Path, dest: &Path) -> Result<usize, String> {
    if !root.is_dir() {
        return Err("笔记库目录不存在".into());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建导出目录：{e}"))?;
    }
    let file = File::create(dest).map_err(|e| format!("无法创建 zip：{e}"))?;
    // zip 可能就建在笔记库里，不能把正在写的自己也打包进去
    let this_zip = fs::canonicalize(dest).ok();
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut count = 0usize;
    add_dir(&mut zip, root, root, options, this_zip.as_deref(), &mut count)?;
    zip.finish().map_err(|e| format!("完成 zip 失败：{e}"))?;
    Ok(count)
}

fn add_dir(
    zip: &mut ZipWriter<File>,
    root: &Path,
    dir: &Path,
    options: SimpleFileOptions,
    this_zip: Option<&Path>,
    count: &mut usize,
) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("读取目录失败 {}：{e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录失败：{e}"))?;
        let path = entry.path();
        let rel = path.strip_prefix(root).map_err(|_| "路径不在笔记库内".to_string())?;
        let rel = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
        let kind = entry.file_type().map_err(|e| format!("读取文件类型失败：{e}"))?;
        if kind.is_dir() {
            if skip_export_dir(&rel) {
                continue;
            }
            add_dir(zip, root, &path, options, this_zip, count)?;
        } else if kind.is_file() && should_sync(&rel) {
            if this_zip.is_some_and(|z| z.file_name() == path.file_name() && fs::canonicalize(&path).ok().as_deref() == Some(z)) {
                continue;
            }
            let mut src = File::open(&path).map_err(|e| format!("读取失败 {}：{e}", path.display()))?;
            zip.start_file(rel.replace('\\', "/"), options).map_err(|e| format!("写入 zip 失败：{e}"))?;
            io::copy(&mut src, zip).map_err(|e| format!("写入 zip 失败 {}：{e}", path.display()))?;
            *count += 1;
        }
    }
    Ok(())
}

fn skip_export_dir(rel: &str) -> bool {
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

pub fn import_zip(zip_path: &Path, dest: &Path) -> Result<usize, String> {
    if dest.exists() {
        let empty = fs::read_dir(dest).map_err(|e| format!("无法读取目标文件夹：{e}"))?.next().is_none();
        if !empty {
            return Err("目标文件夹不是空的，请换一个新文件夹导入".into());
        }
    } else {
        fs::create_dir_all(dest).map_err(|e| format!("无法创建笔记库：{e}"))?;
    }
    let file = File::open(zip_path).map_err(|e| format!("无法打开 zip：{e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("无法读取 zip：{e}"))?;
    let mut count = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("无法读取 zip：{e}"))?;
        let name = entry.name().replace('\\', "/");
        if name.ends_with('/') || !safe_rel(&name) || !should_sync(name.trim_end_matches('/')) {
            continue;
        }
        let dest_path = dest.join(Path::new(&name));
        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("无法创建目录：{e}"))?;
        }
        let mut out = File::create(&dest_path).map_err(|e| format!("无法写入 {}：{e}", dest_path.display()))?;
        io::copy(&mut entry, &mut out).map_err(|e| format!("无法写入 {}：{e}", dest_path.display()))?;
        count += 1;
    }
    if count == 0 {
        return Err("zip 里没有可导入的笔记".into());
    }
    Ok(count)
}

fn safe_rel(name: &str) -> bool {
    let path = Path::new(name);
    !name.starts_with('/') && !name.starts_with('\\') && path.components().all(|c| matches!(c, Component::Normal(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip_roundtrip_skips_history() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("vault");
        fs::create_dir_all(root.join(".ttnote/config")).unwrap();
        fs::create_dir_all(root.join(".ttnote/history")).unwrap();
        fs::create_dir_all(root.join("周报.assets")).unwrap();
        fs::write(root.join("周报.md"), "正文").unwrap();
        fs::write(root.join("周报.assets/a.png"), b"png").unwrap();
        fs::write(root.join(".ttnote/config/order.json"), "{}").unwrap();
        fs::write(root.join(".ttnote/history/old.md"), "旧").unwrap();
        let zip_path = tmp.path().join("out.zip");
        assert_eq!(export_zip(&root, &zip_path).unwrap(), 3);
        let dest = tmp.path().join("imported");
        assert_eq!(import_zip(&zip_path, &dest).unwrap(), 3);
        assert_eq!(fs::read_to_string(dest.join("周报.md")).unwrap(), "正文");
        assert!(dest.join(".ttnote/config/order.json").is_file());
        assert!(!dest.join(".ttnote/history/old.md").exists());
    }

    #[test]
    fn export_into_synced_folder_skips_itself() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("周报.assets")).unwrap();
        fs::write(root.join("周报.md"), "正文").unwrap();
        assert_eq!(export_zip(root, &root.join("周报.assets/备份.zip")).unwrap(), 1);
    }
}
