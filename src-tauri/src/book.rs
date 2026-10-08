//! 表格簿：以 `.book` 结尾的文件夹，里面每张表都是普通的笔记、思维导图或流程图文件。
//! 文件夹里的 `.book.json` 只记录表的顺序；表名就是文件名，同一个簿内表名不能重复（不分类型）。
//! 子文件夹、不认识的文件和嵌套的表格簿不作为表显示，只统计出来提示用户。

use crate::doctype::{self, DocKind};
use crate::fsops::{rewrite_asset_refs, unique_path, validate_name};
use crate::vault::{atomic_write, rel_of, resolve};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::path::Path;

pub const EXT: &str = ".book";
pub const MANIFEST: &str = ".book.json";

/// 文件夹名是否是表格簿（扩展名不区分大小写，`.book` 本身不算）
pub fn is_book_name(name: &str) -> bool {
    !name.starts_with('.') && name.len() > EXT.len() && name.to_ascii_lowercase().ends_with(EXT)
}

/// 路径的最后一段是否是表格簿
pub fn is_book_path(rel: &str) -> bool {
    is_book_name(rel.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or(rel))
}

/// 去掉 `.book` 后缀，用作显示名
pub fn book_stem(name: &str) -> &str {
    if is_book_name(name) { &name[..name.len() - EXT.len()] } else { name }
}

/// 路径是否位于某个表格簿里面（直接子项）
pub fn parent_book(rel: &str) -> Option<&str> {
    let (dir, _) = rel.rsplit_once('/')?;
    is_book_path(dir).then_some(dir)
}

/// `.book.json` 是否是某个表格簿里的清单（WebDAV 同步、导出要带上它）
pub fn is_manifest_path(rel: &str) -> bool {
    rel.rsplit_once('/').map(|(dir, file)| file == MANIFEST && is_book_path(dir)).unwrap_or(false)
}

#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    #[serde(default = "one")]
    version: u32,
    #[serde(default)]
    order: Vec<String>,
}

fn one() -> u32 {
    1
}

/// 表格簿里的内容：表（按顺序，文件名）、不能显示的项目、清单读取出的问题
#[derive(Debug, Default, PartialEq)]
pub struct Layout {
    pub sheets: Vec<String>,
    pub unsupported: Vec<String>,
    pub warning: Option<String>,
}

fn read_manifest(dir: &Path) -> Result<Vec<String>, String> {
    let path = dir.join(MANIFEST);
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str::<Manifest>(&raw)
            .map(|m| m.order)
            .map_err(|e| format!("表格簿顺序文件 {MANIFEST} 无法识别，已按名称排序：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("读取表格簿顺序文件失败，已按名称排序：{e}")),
    }
}

/// 读出表格簿的内容。清单里没有的表追加到最后（按名称），清单里有但文件不存在的条目忽略
pub fn layout(dir: &Path) -> Result<Layout, String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("读取表格簿失败 {}：{e}", dir.display()))?;
    let mut files: Vec<String> = Vec::new();
    let mut unsupported: Vec<String> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取表格簿失败 {}：{e}", dir.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = entry.file_type().map_err(|e| format!("读取文件类型失败 {name}：{e}"))?;
        if name.starts_with('.') || (kind.is_dir() && name.ends_with(".assets")) {
            continue;
        }
        if kind.is_file() && doctype::is_doc(&name) {
            files.push(name);
        } else {
            unsupported.push(name);
        }
    }
    files.sort_by_key(|n| n.to_lowercase());
    unsupported.sort_by_key(|n| n.to_lowercase());

    let (order, warning) = match read_manifest(dir) {
        Ok(order) => (order, None),
        Err(w) => (Vec::new(), Some(w)),
    };
    let present: HashSet<&String> = files.iter().collect();
    let mut seen: HashSet<&String> = HashSet::new();
    let mut sheets: Vec<String> = Vec::with_capacity(files.len());
    for name in &order {
        if let Some(&hit) = present.get(name) {
            if seen.insert(hit) {
                sheets.push(hit.clone());
            }
        }
    }
    sheets.extend(files.iter().filter(|n| !seen.contains(n)).cloned());
    Ok(Layout { sheets, unsupported, warning })
}

fn write_manifest(dir: &Path, order: &[String]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&Manifest { version: 1, order: order.to_vec() }).map_err(|e| e.to_string())?;
    atomic_write(&dir.join(MANIFEST), &(json + "\n"))
}

fn stem_of(file: &str) -> &str {
    doctype::split(file).map(|(s, _)| s).unwrap_or(file)
}

fn taken_stems(sheets: &[String]) -> HashSet<String> {
    sheets.iter().map(|s| stem_of(s).to_lowercase()).collect()
}

fn book_dir(root: &Path, book_rel: &str) -> Result<std::path::PathBuf, String> {
    if !is_book_path(book_rel) {
        return Err(format!("不是表格簿：{book_rel}"));
    }
    let dir = resolve(root, book_rel)?;
    if !dir.is_dir() {
        return Err(format!("表格簿不存在：{book_rel}"));
    }
    Ok(dir)
}

fn create_empty(path: &Path, kind: DocKind) -> Result<(), String> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
        .map_err(|e| format!("新建{}失败 {}：{e}", kind.label(), path.display()))
}

/// 新建表格簿：`名称.book/`，里面有一张空笔记“表 1”；返回表格簿的相对路径
pub fn create_book(root: &Path, dir_rel: &str, name: Option<&str>) -> Result<String, String> {
    let parent = crate::vault::resolve_dir(root, dir_rel)?;
    if !parent.is_dir() {
        return Err(format!("文件夹不存在：{}", parent.display()));
    }
    let typed = validate_name(name.unwrap_or("未命名表格簿"))?;
    let stem = book_stem(&typed).trim().to_string();
    let stem = validate_name(&stem)?;
    let dir = unique_path(&parent, &stem, EXT);
    fs::create_dir(&dir).map_err(|e| format!("新建表格簿失败 {}：{e}", dir.display()))?;
    let first = format!("表 1{}", DocKind::Note.ext());
    let made = create_empty(&dir.join(&first), DocKind::Note).and_then(|_| write_manifest(&dir, &[first]));
    if let Err(e) = made {
        let _ = fs::remove_dir_all(&dir);
        return Err(e);
    }
    rel_of(root, &dir)
}

/// 在表格簿末尾新建一张表。不给名称时依次叫“表 1”“表 2”……（取第一个没用过的数字）；
/// 给了名称但已被占用（不分类型）时，和新建文件一样加序号：`名称 1`、`名称 2`……
pub fn create_sheet(root: &Path, book_rel: &str, kind: DocKind, name: Option<&str>) -> Result<String, String> {
    let dir = book_dir(root, book_rel)?;
    let lay = layout(&dir)?;
    let taken = taken_stems(&lay.sheets);
    let stem = match name {
        Some(n) => {
            let n = validate_name(n)?;
            std::iter::once(n.clone())
                .chain((1..).map(|i| format!("{n} {i}")))
                .find(|s| !taken.contains(&s.to_lowercase()))
                .expect("unbounded range")
        }
        None => (1..).map(|i| format!("表 {i}")).find(|s| !taken.contains(&s.to_lowercase())).expect("unbounded range"),
    };
    let file = format!("{stem}{}", kind.ext());
    create_empty(&dir.join(&file), kind)?;
    let mut order = lay.sheets;
    order.push(file.clone());
    write_manifest(&dir, &order)?;
    rel_of(root, &dir.join(file))
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("复制附件失败 {}：{e}", to.display()))?;
    for entry in fs::read_dir(from).map_err(|e| format!("复制附件失败 {}：{e}", from.display()))? {
        let entry = entry.map_err(|e| format!("复制附件失败：{e}"))?;
        let target = to.join(entry.file_name());
        if entry.file_type().map_err(|e| format!("复制附件失败：{e}"))?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|e| format!("复制附件失败 {}：{e}", target.display()))?;
        }
    }
    Ok(())
}

/// 复制一张表：副本叫“原名 副本”（重名时加序号），排在原表后面；笔记的附件一并复制
pub fn duplicate_sheet(root: &Path, rel: &str) -> Result<String, String> {
    let book_rel = parent_book(rel).ok_or_else(|| format!("不在表格簿里：{rel}"))?;
    let dir = book_dir(root, book_rel)?;
    let src = resolve(root, rel)?;
    let (stem, kind) = doctype::split(rel).ok_or_else(|| format!("不支持的文件类型：{rel}"))?;
    let stem = stem.rsplit('/').next().unwrap_or(stem).to_string();
    let lay = layout(&dir)?;
    let taken = taken_stems(&lay.sheets);
    let new_stem = std::iter::once(format!("{stem} 副本"))
        .chain((2..).map(|i| format!("{stem} 副本 {i}")))
        .find(|s| !taken.contains(&s.to_lowercase()))
        .expect("unbounded range");
    let file = format!("{new_stem}{}", kind.ext());
    let dst = dir.join(&file);
    if kind == DocKind::Note {
        let content = fs::read_to_string(&src).map_err(|e| format!("读取笔记失败 {rel}：{e}"))?;
        let assets = crate::fsops::assets_dir(&src);
        let content = if assets.is_dir() {
            copy_dir(&assets, &crate::fsops::assets_dir(&dst))?;
            rewrite_asset_refs(&content, &stem, &new_stem)
        } else {
            content
        };
        OpenOptions::new().write(true).create_new(true).open(&dst).map_err(|e| format!("复制失败 {}：{e}", dst.display()))?;
        atomic_write(&dst, &content)?;
    } else {
        fs::copy(&src, &dst).map_err(|e| format!("复制失败 {}：{e}", dst.display()))?;
    }
    let src_name = src.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut order = lay.sheets;
    let at = order.iter().position(|n| *n == src_name).map(|i| i + 1).unwrap_or(order.len());
    order.insert(at, file);
    write_manifest(&dir, &order)?;
    rel_of(root, &dst)
}

/// 给表改名：同一个簿内不能和别的表重名（不分类型）；顺序保持不变
pub fn rename_sheet(root: &Path, rel: &str, new_name: &str) -> Result<String, String> {
    let book_rel = parent_book(rel).ok_or_else(|| format!("不在表格簿里：{rel}"))?;
    let dir = book_dir(root, book_rel)?;
    let name = validate_name(new_name)?;
    let lay = layout(&dir)?;
    let old_file = rel.rsplit('/').next().unwrap_or(rel).to_string();
    let others: Vec<String> = lay.sheets.iter().filter(|n| **n != old_file).cloned().collect();
    if taken_stems(&others).contains(&name.to_lowercase()) {
        return Err(format!("这个表格簿里已经有名为“{name}”的表"));
    }
    let new_rel = crate::fsops::rename_entry(root, rel, &name)?;
    let new_file = new_rel.rsplit('/').next().unwrap_or(&new_rel).to_string();
    if new_file != old_file {
        let order: Vec<String> = lay.sheets.iter().map(|n| if *n == old_file { new_file.clone() } else { n.clone() }).collect();
        write_manifest(&dir, &order).map_err(|e| format!("表已改名，但保存顺序失败：{e}"))?;
    }
    Ok(new_rel)
}

/// 保存表的顺序。只接受表格簿里实际存在的表，漏掉的追加到最后
pub fn set_order(root: &Path, book_rel: &str, order: &[String]) -> Result<(), String> {
    let dir = book_dir(root, book_rel)?;
    let lay = layout(&dir)?;
    let present: HashSet<&String> = lay.sheets.iter().collect();
    let mut seen: HashSet<&String> = HashSet::new();
    let mut next: Vec<String> = order.iter().filter(|n| present.contains(n) && seen.insert(n)).cloned().collect();
    let kept: HashSet<String> = next.iter().cloned().collect();
    next.extend(lay.sheets.iter().filter(|n| !kept.contains(*n)).cloned());
    write_manifest(&dir, &next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(l: &Layout) -> Vec<&str> {
        l.sheets.iter().map(String::as_str).collect()
    }

    #[test]
    fn recognizes_book_paths() {
        assert!(is_book_name("周报.book"));
        assert!(is_book_name("周报.BOOK"));
        assert!(!is_book_name(".book"));
        assert!(!is_book_name("周报.books"));
        assert!(is_book_path("工作/周报.book"));
        assert!(!is_book_path("工作/周报.md"));
        assert_eq!(parent_book("工作/周报.book/本周.md"), Some("工作/周报.book"));
        assert_eq!(parent_book("工作/本周.md"), None);
        assert!(is_manifest_path("周报.book/.book.json"));
        assert!(!is_manifest_path("周报/.book.json"));
        assert_eq!(book_stem("周报.book"), "周报");
    }

    #[test]
    fn create_book_has_first_sheet_and_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let rel = create_book(tmp.path(), "", None).unwrap();
        assert_eq!(rel, "未命名表格簿.book");
        let lay = layout(&tmp.path().join(&rel)).unwrap();
        assert_eq!(names(&lay), vec!["表 1.md"]);
        assert_eq!(create_book(tmp.path(), "", Some("周报.book")).unwrap(), "周报.book");
        assert_eq!(create_book(tmp.path(), "", Some("周报")).unwrap(), "周报 1.book");
    }

    #[test]
    fn sheets_follow_manifest_with_missing_and_extra_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("b.book");
        fs::create_dir_all(dir.join("子夹")).unwrap();
        fs::create_dir_all(dir.join("a.assets")).unwrap();
        for f in ["a.md", "b.mind.mmd", "c.flow.mmd", "d.md", "x.txt"] {
            fs::write(dir.join(f), "").unwrap();
        }
        fs::write(dir.join(MANIFEST), r#"{"version":1,"order":["c.flow.mmd","gone.md","a.md","c.flow.mmd"]}"#).unwrap();
        let lay = layout(&dir).unwrap();
        assert_eq!(names(&lay), vec!["c.flow.mmd", "a.md", "b.mind.mmd", "d.md"]);
        assert_eq!(lay.unsupported, vec!["x.txt", "子夹"]);
        assert!(lay.warning.is_none());
    }

    #[test]
    fn corrupt_manifest_sorts_by_name_and_warns() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("b.book");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("b.md"), "").unwrap();
        fs::write(dir.join("a.md"), "").unwrap();
        fs::write(dir.join(MANIFEST), "{坏了").unwrap();
        let lay = layout(&dir).unwrap();
        assert_eq!(names(&lay), vec!["a.md", "b.md"]);
        assert!(lay.warning.unwrap().contains("无法识别"));
    }

    #[test]
    fn new_sheets_are_named_in_sequence_across_kinds() {
        let tmp = tempfile::tempdir().unwrap();
        let book = create_book(tmp.path(), "", Some("簿")).unwrap();
        assert_eq!(create_sheet(tmp.path(), &book, DocKind::Mind, None).unwrap(), "簿.book/表 2.mind.mmd");
        assert_eq!(create_sheet(tmp.path(), &book, DocKind::Flow, None).unwrap(), "簿.book/表 3.flow.mmd");
        // 指定的名称被占用（不分类型）时加序号
        assert_eq!(create_sheet(tmp.path(), &book, DocKind::Note, Some("表 2")).unwrap(), "簿.book/表 2 1.md");
        let lay = layout(&tmp.path().join(&book)).unwrap();
        assert_eq!(names(&lay), vec!["表 1.md", "表 2.mind.mmd", "表 3.flow.mmd", "表 2 1.md"]);
    }

    #[test]
    fn rename_keeps_order_and_rejects_duplicates_across_kinds() {
        let tmp = tempfile::tempdir().unwrap();
        let book = create_book(tmp.path(), "", Some("簿")).unwrap();
        create_sheet(tmp.path(), &book, DocKind::Mind, Some("导图")).unwrap();
        create_sheet(tmp.path(), &book, DocKind::Note, Some("尾")).unwrap();
        let err = rename_sheet(tmp.path(), "簿.book/尾.md", "导图").unwrap_err();
        assert!(err.contains("已经有名为"));
        assert_eq!(rename_sheet(tmp.path(), "簿.book/导图.mind.mmd", "路线").unwrap(), "簿.book/路线.mind.mmd");
        let lay = layout(&tmp.path().join(&book)).unwrap();
        assert_eq!(names(&lay), vec!["表 1.md", "路线.mind.mmd", "尾.md"]);
    }

    #[test]
    fn duplicate_goes_after_original_and_copies_assets() {
        let tmp = tempfile::tempdir().unwrap();
        let book = create_book(tmp.path(), "", Some("簿")).unwrap();
        create_sheet(tmp.path(), &book, DocKind::Note, Some("尾")).unwrap();
        let dir = tmp.path().join(&book);
        fs::write(dir.join("表 1.md"), "图 ![](表 1.assets/a.png)\n").unwrap();
        fs::create_dir_all(dir.join("表 1.assets")).unwrap();
        fs::write(dir.join("表 1.assets/a.png"), "x").unwrap();
        assert_eq!(duplicate_sheet(tmp.path(), "簿.book/表 1.md").unwrap(), "簿.book/表 1 副本.md");
        assert_eq!(duplicate_sheet(tmp.path(), "簿.book/表 1.md").unwrap(), "簿.book/表 1 副本 2.md");
        let lay = layout(&dir).unwrap();
        assert_eq!(names(&lay), vec!["表 1.md", "表 1 副本 2.md", "表 1 副本.md", "尾.md"]);
        assert_eq!(fs::read_to_string(dir.join("表 1 副本.md")).unwrap(), "图 ![](表 1 副本.assets/a.png)\n");
        assert!(dir.join("表 1 副本.assets/a.png").is_file());
        assert!(dir.join("表 1.assets/a.png").is_file());
    }

    #[test]
    fn set_order_ignores_unknown_and_appends_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let book = create_book(tmp.path(), "", Some("簿")).unwrap();
        create_sheet(tmp.path(), &book, DocKind::Note, Some("乙")).unwrap();
        create_sheet(tmp.path(), &book, DocKind::Note, Some("丙")).unwrap();
        set_order(tmp.path(), &book, &["丙.md".into(), "不存在.md".into(), "乙.md".into()]).unwrap();
        let lay = layout(&tmp.path().join(&book)).unwrap();
        assert_eq!(names(&lay), vec!["丙.md", "乙.md", "表 1.md"]);
    }
}
