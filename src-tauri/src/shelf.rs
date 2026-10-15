//! 手机书架：本地导入的书和从云端下载的书。云端目录默认 spark-books，和笔记库分开。

use crate::vault::{atomic_write, atomic_write_bytes};
use crate::webdav::{Dav, RemoteEntry};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const BOOK_EXTS: [&str; 5] = ["epub", "txt", "mobi", "azw3", "pdf"];
/// 能在手机上打开的格式
const READABLE: [&str; 5] = ["epub", "txt", "mobi", "azw3", "pdf"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalBook {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub added_ms: u64,
    /// import：手机导入的；cloud：从云端下载的
    pub origin: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudBook {
    pub rel: String,
    pub name: String,
    pub ext: String,
    pub size: u64,
    pub modified: String,
    /// 手机书架上已有同名文件时，给出它的 id
    pub local_id: Option<String>,
    pub readable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadPlan {
    Put { name: String },
    Conflict { size: u64, modified: String },
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn books_dir(base: &Path) -> PathBuf {
    base.join("mobile").join("shelf")
}

fn catalog_path(base: &Path) -> PathBuf {
    books_dir(base).join("books.json")
}

fn file_dir(base: &Path, id: &str) -> PathBuf {
    books_dir(base).join("files").join(id)
}

pub fn book_ext(name: &str) -> Option<String> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    BOOK_EXTS.contains(&ext.as_str()).then_some(ext)
}

fn readable(ext: &str) -> bool {
    READABLE.contains(&ext)
}

fn load(base: &Path) -> Result<Vec<LocalBook>, String> {
    match fs::read_to_string(catalog_path(base)) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("书架记录损坏：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("读取书架失败：{e}")),
    }
}

fn save(base: &Path, books: &[LocalBook]) -> Result<(), String> {
    let path = catalog_path(base);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建书架目录失败：{e}"))?;
    }
    atomic_write(&path, &serde_json::to_string_pretty(books).map_err(|e| e.to_string())?)
}

fn new_id(books: &[LocalBook]) -> String {
    let mut n = now_ms();
    loop {
        let id = format!("{n:x}");
        if !books.iter().any(|b| b.id == id) {
            return id;
        }
        n += 1;
    }
}

/// 同名时在扩展名前加“ (2)”“ (3)”
pub fn alt_name(name: &str, n: u32) -> String {
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = path.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    format!("{stem} ({n}){ext}")
}

fn unique_name(taken: &[String], name: &str) -> String {
    if !taken.iter().any(|t| t == name) {
        return name.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = alt_name(name, n);
        if !taken.iter().any(|t| t == &candidate) {
            return candidate;
        }
        n += 1;
    }
}

fn add_book(base: &Path, name: &str, bytes: &[u8], origin: &str) -> Result<LocalBook, String> {
    let mut books = load(base)?;
    let name = unique_name(&books.iter().map(|b| b.name.clone()).collect::<Vec<_>>(), name);
    let id = new_id(&books);
    let dir = file_dir(base, &id);
    fs::create_dir_all(&dir).map_err(|e| format!("创建书籍目录失败：{e}"))?;
    atomic_write_bytes(&dir.join(&name), bytes)?;
    let book = LocalBook { id, name, size: bytes.len() as u64, added_ms: now_ms(), origin: origin.to_string() };
    books.push(book.clone());
    save(base, &books)?;
    Ok(book)
}

pub fn import_bytes(base: &Path, name: &str, bytes: &[u8]) -> Result<LocalBook, String> {
    if book_ext(name).is_none() {
        return Err(format!("不支持的格式：{name}（支持 epub、txt、mobi、azw3、pdf）"));
    }
    add_book(base, name, bytes, "import")
}

pub fn import_path(base: &Path, source: &Path) -> Result<LocalBook, String> {
    let name = source.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
    let bytes = fs::read(source).map_err(|e| format!("读取书籍失败：{e}"))?;
    import_bytes(base, &name, &bytes)
}

pub fn list_local(base: &Path) -> Result<Vec<LocalBook>, String> {
    let mut books = load(base)?;
    books.sort_by(|a, b| b.added_ms.cmp(&a.added_ms).then(a.name.cmp(&b.name)));
    Ok(books)
}

pub fn book_file(base: &Path, id: &str) -> Result<(LocalBook, PathBuf), String> {
    let book = load(base)?.into_iter().find(|b| b.id == id).ok_or("书架上没有这本书")?;
    Ok((book.clone(), file_dir(base, id).join(&book.name)))
}

pub fn remove_local(base: &Path, id: &str) -> Result<(), String> {
    let mut books = load(base)?;
    if !books.iter().any(|b| b.id == id) {
        return Err("书架上没有这本书".into());
    }
    books.retain(|b| b.id != id);
    save(base, &books)?;
    let dir = file_dir(base, id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("删除书籍失败：{e}"))?;
    }
    for path in [cover_path(base, id), no_cover_path(base, id)] {
        let _ = fs::remove_file(path);
    }
    drop_notes(base, id)?;
    drop_bookmarks(base, id)?;
    Ok(())
}

fn covers_dir(base: &Path) -> PathBuf {
    books_dir(base).join("covers")
}

fn cover_path(base: &Path, id: &str) -> PathBuf {
    covers_dir(base).join(format!("{id}.jpg"))
}

/// 书里没有封面时留一个空标记，下次不再去书里找
fn no_cover_path(base: &Path, id: &str) -> PathBuf {
    covers_dir(base).join(format!("{id}.none"))
}

/// 已经处理过封面的书：有封面的给出图片路径，没有封面的是空字符串；没处理过的不在里面
pub fn list_covers(base: &Path) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut out = std::collections::BTreeMap::new();
    for book in load(base)? {
        let cover = cover_path(base, &book.id);
        if cover.is_file() {
            out.insert(book.id, cover.to_string_lossy().into_owned());
        } else if no_cover_path(base, &book.id).is_file() {
            out.insert(book.id, String::new());
        }
    }
    Ok(out)
}

/// 保存封面（前端从书里取出、缩小后的 JPEG）；`data` 为空表示这本书没有封面
pub fn save_cover(base: &Path, id: &str, data: &[u8]) -> Result<(), String> {
    if !load(base)?.iter().any(|b| b.id == id) {
        return Err("书架上没有这本书".into());
    }
    fs::create_dir_all(covers_dir(base)).map_err(|e| format!("创建封面目录失败：{e}"))?;
    if data.is_empty() {
        return atomic_write(&no_cover_path(base, id), "");
    }
    atomic_write_bytes(&cover_path(base, id), data)
}

/// 只删从云端下载的副本，导入的书留着
pub fn remove_downloads(base: &Path) -> Result<u32, String> {
    let books = load(base)?;
    let ids: Vec<String> = books.iter().filter(|b| b.origin == "cloud").map(|b| b.id.clone()).collect();
    let n = ids.len() as u32;
    for id in ids {
        remove_local(base, &id)?;
    }
    Ok(n)
}

pub fn usage(base: &Path) -> Result<(u32, u64), String> {
    let books = load(base)?;
    Ok((books.len() as u32, books.iter().map(|b| b.size).sum()))
}

fn file_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

fn hidden(rel: &str) -> bool {
    rel.split('/').any(|p| p.starts_with('.'))
}

/// 云端书架里的书：跳过隐藏目录和回收站，子文件夹里的书摊平
pub fn cloud_books(entries: &[RemoteEntry], local: &[LocalBook]) -> Vec<CloudBook> {
    let mut out = Vec::new();
    for e in entries {
        if e.is_dir || hidden(&e.rel) {
            continue;
        }
        let Some(ext) = book_ext(file_name(&e.rel)) else { continue };
        let name = file_name(&e.rel).to_string();
        let can_read = readable(&ext);
        out.push(CloudBook {
            rel: e.rel.clone(),
            name: name.clone(),
            ext,
            size: e.size.unwrap_or(0),
            modified: e.modified.clone(),
            local_id: local.iter().find(|b| b.name == name).map(|b| b.id.clone()),
            readable: can_read,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub fn trash_rel(rel: &str, stamp: &str) -> String {
    format!(".spark-trash/{stamp}/{}", rel.trim_matches('/'))
}

/// 决定这次上传写到哪个文件名。云端已有同名文件时，check 先停下来问用户。
pub fn plan_upload(name: &str, remote: &[CloudBook], mode: &str) -> UploadPlan {
    let hit = remote.iter().find(|b| b.name == name);
    match (hit, mode) {
        (None, _) => UploadPlan::Put { name: name.to_string() },
        (Some(b), "overwrite") => UploadPlan::Put { name: b.name.clone() },
        (Some(_), "rename") => {
            let taken: Vec<String> = remote.iter().map(|b| b.name.clone()).collect();
            UploadPlan::Put { name: unique_name(&taken, name) }
        }
        (Some(b), _) => UploadPlan::Conflict { size: b.size, modified: b.modified.clone() },
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadPoint {
    pub cfi: String,
    pub fraction: f64,
    pub updated_ms: u64,
    /// 原生左右翻页的章节号。没有时仍用 cfi
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<i32>,
    /// 这一章正文里的字符偏移。没有时仍用 cfi
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub char_offset: Option<i32>,
}

fn progress_path(base: &Path) -> PathBuf {
    books_dir(base).join("progress.json")
}

fn load_progress(base: &Path) -> Result<std::collections::BTreeMap<String, ReadPoint>, String> {
    match fs::read_to_string(progress_path(base)) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("阅读进度损坏：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(std::collections::BTreeMap::new()),
        Err(e) => Err(format!("读取阅读进度失败：{e}")),
    }
}

fn save_progress(base: &Path, map: &std::collections::BTreeMap<String, ReadPoint>) -> Result<(), String> {
    let path = progress_path(base);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建书架目录失败：{e}"))?;
    }
    atomic_write(&path, &serde_json::to_string_pretty(map).map_err(|e| e.to_string())?)
}

pub fn read_point(base: &Path, id: &str) -> Result<Option<ReadPoint>, String> {
    Ok(load_progress(base)?.get(id).cloned())
}

pub fn write_point(base: &Path, id: &str, point: ReadPoint) -> Result<(), String> {
    let mut map = load_progress(base)?;
    map.insert(id.to_string(), point);
    save_progress(base, &map)
}

fn notes_path(base: &Path) -> PathBuf {
    books_dir(base).join("notes.json")
}

/// 每本书一份读书笔记（划线、心得、总结）。只在这台手机上，不进笔记库
fn load_notes(base: &Path) -> Result<std::collections::BTreeMap<String, String>, String> {
    match fs::read_to_string(notes_path(base)) {
        Ok(s) if s.trim().is_empty() => Ok(std::collections::BTreeMap::new()),
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("读书笔记损坏：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(std::collections::BTreeMap::new()),
        Err(e) => Err(format!("读取读书笔记失败：{e}")),
    }
}

fn save_notes_map(base: &Path, map: &std::collections::BTreeMap<String, String>) -> Result<(), String> {
    let path = notes_path(base);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建书架目录失败：{e}"))?;
    }
    atomic_write(&path, &serde_json::to_string(map).map_err(|e| e.to_string())?)
}

pub fn read_notes(base: &Path, id: &str) -> Result<String, String> {
    Ok(load_notes(base)?.get(id).cloned().unwrap_or_default())
}

pub fn write_notes(base: &Path, id: &str, content: &str) -> Result<(), String> {
    let mut map = load_notes(base)?;
    if content.trim().is_empty() {
        map.remove(id);
    } else {
        map.insert(id.to_string(), content.to_string());
    }
    save_notes_map(base, &map)
}

fn drop_notes(base: &Path, id: &str) -> Result<(), String> {
    let mut map = load_notes(base)?;
    if map.remove(id).is_none() {
        return Ok(());
    }
    save_notes_map(base, &map)
}

fn bookmarks_path(base: &Path) -> PathBuf {
    books_dir(base).join("bookmarks.json")
}

fn load_bookmarks(base: &Path) -> Result<std::collections::BTreeMap<String, String>, String> {
    match fs::read_to_string(bookmarks_path(base)) {
        Ok(s) if s.trim().is_empty() => Ok(std::collections::BTreeMap::new()),
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("书签损坏：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(std::collections::BTreeMap::new()),
        Err(e) => Err(format!("读取书签失败：{e}")),
    }
}

fn save_bookmarks_map(base: &Path, map: &std::collections::BTreeMap<String, String>) -> Result<(), String> {
    let path = bookmarks_path(base);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建书架目录失败：{e}"))?;
    }
    atomic_write(&path, &serde_json::to_string(map).map_err(|e| e.to_string())?)
}

pub fn read_bookmarks(base: &Path, id: &str) -> Result<String, String> {
    Ok(load_bookmarks(base)?.get(id).cloned().unwrap_or_default())
}

pub fn write_bookmarks(base: &Path, id: &str, content: &str) -> Result<(), String> {
    let mut map = load_bookmarks(base)?;
    if content.trim().is_empty() || content.trim() == "[]" {
        map.remove(id);
    } else {
        map.insert(id.to_string(), content.to_string());
    }
    save_bookmarks_map(base, &map)
}

fn drop_bookmarks(base: &Path, id: &str) -> Result<(), String> {
    let mut map = load_bookmarks(base)?;
    if map.remove(id).is_none() {
        return Ok(());
    }
    save_bookmarks_map(base, &map)
}

/// 云端更新的那份胜出；时间相同用本地的
pub fn newer_point(local: Option<ReadPoint>, cloud: Option<ReadPoint>) -> Option<ReadPoint> {
    match (local, cloud) {
        (Some(a), Some(b)) if b.updated_ms > a.updated_ms => Some(b),
        (Some(a), _) => Some(a),
        (None, cloud) => cloud,
    }
}

/// 把一本书的进度合进云端的 progress.json，其他书的记录保留
pub fn merge_progress_json(raw: &str, name: &str, point: &ReadPoint) -> Result<String, String> {
    let mut map: std::collections::BTreeMap<String, ReadPoint> =
        if raw.trim().is_empty() { std::collections::BTreeMap::new() } else { serde_json::from_str(raw).map_err(|e| format!("云端阅读进度损坏：{e}"))? };
    map.insert(name.to_string(), point.clone());
    serde_json::to_string_pretty(&map).map_err(|e| e.to_string())
}

pub fn save_download(base: &Path, name: &str, bytes: &[u8]) -> Result<LocalBook, String> {
    if book_ext(name).filter(|e| readable(e)).is_none() {
        return Err(format!("还不能下载：{name}"));
    }
    if let Some(existing) = load(base)?.into_iter().find(|b| b.name == name) {
        return Ok(existing);
    }
    add_book(base, name, bytes, "cloud")
}

#[cfg(target_os = "android")]
pub mod commands {
    use super::*;
    use crate::mobile::{list_vaults, VaultConfig};
    use crate::secret::read_secret;
    use crate::webdav::UreqDav;
    use std::fs::File;
    use std::io::Read;
    use tauri::{AppHandle, Manager};

    fn app_base(app: &AppHandle) -> Result<PathBuf, String> {
        app.path().app_data_dir().map_err(|e| format!("找不到应用数据目录：{e}"))
    }

    async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
        tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("后台任务失败：{e}"))?
    }

    fn vault(base: &Path, id: &str) -> Result<VaultConfig, String> {
        list_vaults(base)?.into_iter().find(|v| v.id == id).ok_or_else(|| "没有这个笔记库".into())
    }

    fn dav_for(base: &Path, vault_id: &str, remote_dir: &str) -> Result<UreqDav, String> {
        let v = vault(base, vault_id)?;
        let password = read_secret(&format!("Spark:mobile:{vault_id}"))?.ok_or("没有保存密码，请在「我的」里重新填写")?;
        UreqDav::new(&v.url, remote_dir, &v.username, &password)
    }

    fn stamp() -> String {
        chrono::Local::now().format("%Y-%m-%d/%H%M%S").to_string()
    }

    fn read_book(base: &Path, id: &str) -> Result<(LocalBook, Vec<u8>), String> {
        let (book, path) = book_file(base, id)?;
        let mut file = File::open(&path).map_err(|e| format!("读取书籍失败：{e}"))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|e| format!("读取书籍失败：{e}"))?;
        Ok((book, bytes))
    }

    #[tauri::command]
    pub async fn shelf_list(app: AppHandle) -> Result<Vec<LocalBook>, String> {
        blocking(move || list_local(&app_base(&app)?)).await
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ShelfUsage {
        pub books: u32,
        pub bytes: u64,
    }

    #[tauri::command]
    pub async fn shelf_usage(app: AppHandle) -> Result<ShelfUsage, String> {
        blocking(move || {
            let (books, bytes) = usage(&app_base(&app)?)?;
            Ok(ShelfUsage { books, bytes })
        })
        .await
    }

    #[tauri::command]
    pub async fn shelf_import(app: AppHandle, paths: Vec<String>) -> Result<Vec<LocalBook>, String> {
        blocking(move || {
            let base = app_base(&app)?;
            let mut out = Vec::new();
            for path in &paths {
                // 系统文件选择器给的是 content:// 地址，不能按路径读，先拷到缓存目录
                if path.starts_with("content://") {
                    let cached = crate::secret_android::copy_to_cache(path)?;
                    let copied = PathBuf::from(&cached.path);
                    let result = import_path(&base, &copied);
                    if let Some(dir) = copied.parent() {
                        let _ = fs::remove_dir_all(dir);
                    }
                    out.push(result?);
                } else {
                    out.push(import_path(&base, Path::new(path.strip_prefix("file://").unwrap_or(path)))?);
                }
            }
            Ok(out)
        })
        .await
    }

    #[tauri::command]
    pub async fn shelf_remove(app: AppHandle, id: String) -> Result<(), String> {
        blocking(move || remove_local(&app_base(&app)?, &id)).await
    }

    #[tauri::command]
    pub async fn shelf_remove_downloads(app: AppHandle) -> Result<u32, String> {
        blocking(move || remove_downloads(&app_base(&app)?)).await
    }

    #[tauri::command]
    pub async fn shelf_cloud(app: AppHandle, vault_id: String, remote_dir: String) -> Result<Vec<CloudBook>, String> {
        blocking(move || {
            let base = app_base(&app)?;
            let dav = dav_for(&base, &vault_id, &remote_dir)?;
            let local = list_local(&base)?;
            Ok(cloud_books(&dav.list()?, &local))
        })
        .await
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct UploadOutcome {
        pub done: bool,
        pub name: String,
        pub size: u64,
        pub modified: String,
    }

    #[tauri::command]
    pub async fn shelf_upload(app: AppHandle, vault_id: String, remote_dir: String, id: String, mode: String) -> Result<UploadOutcome, String> {
        blocking(move || {
            let base = app_base(&app)?;
            let (book, bytes) = read_book(&base, &id)?;
            let dav = dav_for(&base, &vault_id, &remote_dir)?;
            let remote = cloud_books(&dav.list()?, &[]);
            match plan_upload(&book.name, &remote, &mode) {
                UploadPlan::Conflict { size, modified } => Ok(UploadOutcome { done: false, name: book.name, size, modified }),
                UploadPlan::Put { .. } => {
                    let name = upload_book(&dav, &book.name, &bytes, &remote, &mode, &stamp())?;
                    Ok(UploadOutcome { done: true, name, size: 0, modified: String::new() })
                }
            }
        })
        .await
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DownloadProgress {
        pub done: u64,
        pub total: Option<u64>,
    }

    #[tauri::command]
    pub async fn shelf_download(
        app: AppHandle,
        vault_id: String,
        remote_dir: String,
        rel: String,
        on_progress: tauri::ipc::Channel<DownloadProgress>,
    ) -> Result<LocalBook, String> {
        blocking(move || {
            let base = app_base(&app)?;
            let dav = dav_for(&base, &vault_id, &remote_dir)?;
            let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
            let bytes = dav.get_with_progress(&rel, &|done, total| {
                let _ = on_progress.send(DownloadProgress { done, total });
            })?;
            save_download(&base, &name, &bytes)
        })
        .await
    }

    #[tauri::command]
    pub async fn shelf_delete_cloud(app: AppHandle, vault_id: String, remote_dir: String, rel: String) -> Result<(), String> {
        blocking(move || {
            let base = app_base(&app)?;
            let dav = dav_for(&base, &vault_id, &remote_dir)?;
            dav.ensure_dir(".spark-trash")?;
            dav.move_to(&rel, &trash_rel(&rel, &stamp()))?;
            if let Some(name) = rel.rsplit('/').next() {
                if let Some(book) = list_local(&base)?.into_iter().find(|b| b.name == name) {
                    remove_local(&base, &book.id)?;
                }
            }
            Ok(())
        })
        .await
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct OpenedBook {
        pub path: String,
        pub name: String,
    }

    #[tauri::command]
    pub async fn shelf_book_file(app: AppHandle, id: String) -> Result<OpenedBook, String> {
        blocking(move || {
            let base = app_base(&app)?;
            let (book, path) = book_file(&base, &id)?;
            if let Some(dir) = path.parent() {
                app.asset_protocol_scope().allow_directory(dir, true).map_err(|e| format!("放行书籍目录失败：{e}"))?;
            }
            Ok(OpenedBook { path: path.to_string_lossy().into_owned(), name: book.name })
        })
        .await
    }

    /// 手机上记下的阅读位置，打开书时先用它，不等网络
    #[tauri::command]
    pub async fn shelf_read_point(app: AppHandle, id: String) -> Result<Option<ReadPoint>, String> {
        blocking(move || read_point(&app_base(&app)?, &id)).await
    }

    /// 书架封面：有封面的给出图片路径（已放行给页面读取），没有封面的是空字符串
    #[tauri::command]
    pub async fn shelf_covers(app: AppHandle) -> Result<std::collections::BTreeMap<String, String>, String> {
        blocking(move || {
            let base = app_base(&app)?;
            let dir = covers_dir(&base);
            if dir.exists() {
                app.asset_protocol_scope().allow_directory(&dir, false).map_err(|e| format!("放行封面目录失败：{e}"))?;
            }
            list_covers(&base)
        })
        .await
    }

    #[tauri::command]
    pub async fn shelf_cover_save(app: AppHandle, id: String, data: Vec<u8>) -> Result<(), String> {
        blocking(move || save_cover(&app_base(&app)?, &id, &data)).await
    }

    /// 书架上每本书读到哪里（0～1），书架页显示“读到 23%”用
    #[tauri::command]
    pub async fn shelf_progress(app: AppHandle) -> Result<std::collections::BTreeMap<String, f64>, String> {
        blocking(move || Ok(load_progress(&app_base(&app)?)?.into_iter().map(|(id, p)| (id, p.fraction)).collect())).await
    }

    #[tauri::command]
    pub async fn shelf_save_point(app: AppHandle, id: String, point: ReadPoint) -> Result<(), String> {
        blocking(move || write_point(&app_base(&app)?, &id, point)).await
    }

    /// 这本书的划线、心得和总结。没有时是空字符串
    #[tauri::command]
    pub async fn shelf_read_notes(app: AppHandle, id: String) -> Result<String, String> {
        blocking(move || read_notes(&app_base(&app)?, &id)).await
    }

    /// 整份覆盖这本书的读书笔记。空内容表示删掉
    #[tauri::command]
    pub async fn shelf_save_notes(app: AppHandle, id: String, content: String) -> Result<(), String> {
        blocking(move || write_notes(&app_base(&app)?, &id, &content)).await
    }

    /// 这本书的书签。没有时是空字符串
    #[tauri::command]
    pub async fn shelf_read_bookmarks(app: AppHandle, id: String) -> Result<String, String> {
        blocking(move || read_bookmarks(&app_base(&app)?, &id)).await
    }

    /// 整份覆盖这本书的书签。空内容或 [] 表示删掉
    #[tauri::command]
    pub async fn shelf_save_bookmarks(app: AppHandle, id: String, content: String) -> Result<(), String> {
        blocking(move || write_bookmarks(&app_base(&app)?, &id, &content)).await
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SyncedPoint {
        pub point: Option<ReadPoint>,
        pub from_cloud: bool,
    }

    /// 打开书时调用：云端进度更新就用云端的，否则把本地进度传上去
    #[tauri::command]
    pub async fn shelf_sync_point(app: AppHandle, vault_id: String, remote_dir: String, id: String) -> Result<SyncedPoint, String> {
        blocking(move || {
            let base = app_base(&app)?;
            let (book, _) = book_file(&base, &id)?;
            let local = read_point(&base, &id)?;
            if vault_id.is_empty() {
                return Ok(SyncedPoint { point: local, from_cloud: false });
            }
            let dav = dav_for(&base, &vault_id, &remote_dir)?;
            let raw = match dav.get(".spark/progress.json") {
                Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                Err(_) => String::new(),
            };
            let map: std::collections::BTreeMap<String, ReadPoint> =
                if raw.trim().is_empty() { std::collections::BTreeMap::new() } else { serde_json::from_str(&raw).unwrap_or_default() };
            let cloud = map.get(&book.name).cloned();
            let chosen = newer_point(local.clone(), cloud.clone());
            let from_cloud = match (&local, &cloud) {
                (Some(a), Some(b)) => b.updated_ms > a.updated_ms,
                (None, Some(_)) => true,
                _ => false,
            };
            if from_cloud {
                if let Some(point) = &chosen {
                    write_point(&base, &id, point.clone())?;
                }
            } else if let Some(point) = &local {
                let next = merge_progress_json(&raw, &book.name, point)?;
                dav.ensure_dir(".spark")?;
                dav.put(".spark/progress.json", next.as_bytes())?;
            }
            Ok(SyncedPoint { point: chosen, from_cloud })
        })
        .await
    }

    /// 退出阅读时把这本书的进度写上云端，不覆盖别的书
    #[tauri::command]
    pub async fn shelf_push_point(app: AppHandle, vault_id: String, remote_dir: String, id: String) -> Result<(), String> {
        blocking(move || {
            if vault_id.is_empty() {
                return Ok(());
            }
            let base = app_base(&app)?;
            let Some(point) = read_point(&base, &id)? else { return Ok(()) };
            let (book, _) = book_file(&base, &id)?;
            let dav = dav_for(&base, &vault_id, &remote_dir)?;
            let raw = match dav.get(".spark/progress.json") {
                Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                Err(_) => String::new(),
            };
            let next = merge_progress_json(&raw, &book.name, &point)?;
            dav.ensure_dir(".spark")?;
            dav.put(".spark/progress.json", next.as_bytes())?;
            Ok(())
        })
        .await
    }

    fn check_rel(rel: &str) -> Result<(), String> {
        if rel.is_empty() || rel.split('/').any(|p| p.is_empty() || p == "." || p == "..") {
            Err("路径不对".into())
        } else {
            Ok(())
        }
    }

    fn read_dav(dav: &UreqDav, rel: &str) -> String {
        match dav.get(rel) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(_) => String::new(),
        }
    }

    /// 读笔记库里的一个文件：先读云端，云端没有时用手机上的副本
    #[tauri::command]
    pub async fn vault_text_read(app: AppHandle, vault_id: String, rel: String) -> Result<String, String> {
        blocking(move || {
            check_rel(&rel)?;
            let base = app_base(&app)?;
            let v = vault(&base, &vault_id)?;
            let password = read_secret(&format!("Spark:mobile:{vault_id}"))?.ok_or("没有保存密码，请在「我的」里重新填写")?;
            let dav = UreqDav::new(&v.url, &v.remote_dir, &v.username, &password)?;
            let remote = read_dav(&dav, &rel);
            if !remote.is_empty() {
                return Ok(remote);
            }
            let path = crate::mobile::vault_root(&base, &vault_id)?.join(&rel);
            match fs::read_to_string(&path) {
                Ok(s) => Ok(s),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
                Err(e) => Err(format!("读取笔记失败：{e}")),
            }
        })
        .await
    }

    /// 先上传到这个库的云端目录，成功后再写入手机上的副本
    #[tauri::command]
    pub async fn vault_text_write(app: AppHandle, vault_id: String, rel: String, content: String) -> Result<(), String> {
        blocking(move || {
            check_rel(&rel)?;
            let base = app_base(&app)?;
            let v = vault(&base, &vault_id)?;
            let password = read_secret(&format!("Spark:mobile:{vault_id}"))?.ok_or("没有保存密码，请在「我的」里重新填写")?;
            let dav = UreqDav::new(&v.url, &v.remote_dir, &v.username, &password)?;
            if let Some(parent) = Path::new(&rel).parent() {
                let parent = parent.to_string_lossy().replace('\\', "/");
                if !parent.is_empty() {
                    dav.ensure_dir(&parent)?;
                }
            }
            // 先上传。上传失败时不改手机上的副本，避免下次用旧的云端内容盖掉没传上去的划线
            dav.put(&rel, content.as_bytes())?;
            let path = crate::mobile::vault_root(&base, &vault_id)?.join(&rel);
            if let Some(dir) = path.parent() {
                fs::create_dir_all(dir).map_err(|e| format!("创建笔记目录失败：{e}"))?;
            }
            crate::vault::atomic_write(&path, &content)?;
            Ok(())
        })
        .await
    }

    #[tauri::command]
    pub async fn shelf_text_read(app: AppHandle, vault_id: String, remote_dir: String, rel: String) -> Result<String, String> {
        blocking(move || {
            check_rel(&rel)?;
            let dav = dav_for(&app_base(&app)?, &vault_id, &remote_dir)?;
            Ok(read_dav(&dav, &rel))
        })
        .await
    }

    #[tauri::command]
    pub async fn shelf_text_write(app: AppHandle, vault_id: String, remote_dir: String, rel: String, content: String) -> Result<(), String> {
        blocking(move || {
            check_rel(&rel)?;
            let dav = dav_for(&app_base(&app)?, &vault_id, &remote_dir)?;
            if let Some(parent) = Path::new(&rel).parent() {
                let parent = parent.to_string_lossy().replace('\\', "/");
                if !parent.is_empty() {
                    dav.ensure_dir(&parent)?;
                }
            }
            dav.put(&rel, content.as_bytes())?;
            Ok(())
        })
        .await
    }
}

/// 上传一本书。overwrite 时先把云端旧文件移进回收站。
pub fn upload_book(dav: &dyn Dav, name: &str, bytes: &[u8], remote: &[CloudBook], mode: &str, stamp: &str) -> Result<String, String> {
    match plan_upload(name, remote, mode) {
        UploadPlan::Conflict { .. } => Err("云端已有同名文件".into()),
        UploadPlan::Put { name: target } => {
            if mode == "overwrite" && remote.iter().any(|b| b.name == name) {
                let rel = remote.iter().find(|b| b.name == name).map(|b| b.rel.clone()).unwrap_or(name.to_string());
                dav.ensure_dir(".spark-trash")?;
                dav.move_to(&rel, &trash_rel(&rel, stamp))?;
            }
            dav.ensure_root()?;
            dav.put(&target, bytes)?;
            Ok(target)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    fn entry(rel: &str, dir: bool, size: u64) -> RemoteEntry {
        RemoteEntry { rel: rel.into(), etag: String::new(), is_dir: dir, size: Some(size), modified: "2026-10-09".into() }
    }

    struct MemDav {
        files: RefCell<BTreeMap<String, Vec<u8>>>,
    }

    impl Dav for MemDav {
        fn list(&self) -> Result<Vec<RemoteEntry>, String> {
            Ok(self.files.borrow().iter().map(|(k, v)| entry(k, false, v.len() as u64)).collect())
        }
        fn get(&self, rel: &str) -> Result<Vec<u8>, String> {
            self.files.borrow().get(rel).cloned().ok_or_else(|| "没有".into())
        }
        fn put(&self, rel: &str, bytes: &[u8]) -> Result<String, String> {
            self.files.borrow_mut().insert(rel.into(), bytes.to_vec());
            Ok(String::new())
        }
        fn delete(&self, rel: &str) -> Result<(), String> {
            self.files.borrow_mut().remove(rel);
            Ok(())
        }
        fn ensure_dir(&self, _rel: &str) -> Result<(), String> {
            Ok(())
        }
        fn move_to(&self, from: &str, to: &str) -> Result<(), String> {
            let bytes = self.get(from)?;
            self.put(to, &bytes)?;
            self.delete(from)
        }
    }

    #[test]
    fn imports_and_renames_duplicates() {
        let dir = std::env::temp_dir().join(format!("spark-shelf-{}", now_ms()));
        let a = import_bytes(&dir, "三体.epub", b"aaa").unwrap();
        let b = import_bytes(&dir, "三体.epub", b"bbbb").unwrap();
        assert_eq!(a.name, "三体.epub");
        assert_eq!(b.name, "三体 (2).epub");
        assert_eq!(a.origin, "import");
        assert!(import_bytes(&dir, "图片.png", b"x").is_err());
        assert_eq!(import_bytes(&dir, "笔记.pdf", b"pdf").unwrap().name, "笔记.pdf");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn notes_stay_on_this_phone_and_leave_with_the_book() {
        let dir = std::env::temp_dir().join(format!("spark-shelf-notes-{}", now_ms()));
        let book = import_bytes(&dir, "三体.epub", b"a").unwrap();
        assert_eq!(read_notes(&dir, &book.id).unwrap(), "");
        write_notes(&dir, &book.id, "{\"annos\":[]}").unwrap();
        assert_eq!(read_notes(&dir, &book.id).unwrap(), "{\"annos\":[]}");
        write_notes(&dir, &book.id, "").unwrap();
        assert_eq!(read_notes(&dir, &book.id).unwrap(), "");
        write_notes(&dir, &book.id, "{\"summary\":\"读完了\"}").unwrap();
        write_bookmarks(&dir, &book.id, "[{\"id\":\"b1\"}]").unwrap();
        assert_eq!(read_bookmarks(&dir, &book.id).unwrap(), "[{\"id\":\"b1\"}]");
        remove_local(&dir, &book.id).unwrap();
        assert_eq!(read_notes(&dir, &book.id).unwrap(), "");
        assert_eq!(read_bookmarks(&dir, &book.id).unwrap(), "");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn covers_are_remembered_and_removed_with_the_book() {
        let dir = std::env::temp_dir().join(format!("spark-shelf-cover-{}", now_ms()));
        let a = import_bytes(&dir, "三体.epub", b"a").unwrap();
        let b = import_bytes(&dir, "平凡的世界.txt", b"b").unwrap();
        assert!(list_covers(&dir).unwrap().is_empty());
        save_cover(&dir, &a.id, b"jpeg").unwrap();
        save_cover(&dir, &b.id, b"").unwrap();
        let covers = list_covers(&dir).unwrap();
        assert!(covers[&a.id].ends_with(&format!("{}.jpg", a.id)));
        assert_eq!(covers[&b.id], "");
        assert!(save_cover(&dir, "nope", b"x").is_err());
        remove_local(&dir, &a.id).unwrap();
        assert!(!cover_path(&dir, &a.id).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_downloads_keeps_imports() {
        let dir = std::env::temp_dir().join(format!("spark-shelf-rm-{}", now_ms()));
        import_bytes(&dir, "三体.epub", b"a").unwrap();
        save_download(&dir, "原则.mobi", b"bb").unwrap();
        assert_eq!(remove_downloads(&dir).unwrap(), 1);
        let left = list_local(&dir).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].name, "三体.epub");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cloud_list_flattens_and_skips_hidden() {
        let entries = vec![
            entry("人类简史.epub", false, 10),
            entry("小说/三体.epub", false, 20),
            entry(".spark/progress.json", false, 1),
            entry(".spark-trash/2026/旧.epub", false, 5),
            entry("封面.png", false, 3),
            entry("深入理解计算机系统.pdf", false, 30),
        ];
        let local = vec![LocalBook { id: "1".into(), name: "人类简史.epub".into(), size: 10, added_ms: 1, origin: "cloud".into() }];
        let books = cloud_books(&entries, &local);
        assert_eq!(books.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(), ["三体.epub", "人类简史.epub", "深入理解计算机系统.pdf"]);
        assert_eq!(books.iter().find(|b| b.name == "人类简史.epub").unwrap().local_id.as_deref(), Some("1"));
        assert!(books.iter().find(|b| b.name.ends_with(".pdf")).unwrap().readable);
    }

    #[test]
    fn upload_asks_before_overwrite_and_keeps_old_in_trash() {
        let remote = cloud_books(&[entry("三体.epub", false, 18)], &[]);
        assert!(matches!(plan_upload("三体.epub", &remote, "check"), UploadPlan::Conflict { size: 18, .. }));
        let dav = MemDav { files: RefCell::new(BTreeMap::from([("三体.epub".into(), b"old".to_vec())])) };
        let written = upload_book(&dav, "三体.epub", b"new", &remote, "overwrite", "2026-10-09/153000").unwrap();
        assert_eq!(written, "三体.epub");
        assert_eq!(dav.get("三体.epub").unwrap(), b"new");
        assert_eq!(dav.get(".spark-trash/2026-10-09/153000/三体.epub").unwrap(), b"old");
        let renamed = upload_book(&dav, "三体.epub", b"copy", &cloud_books(&dav.list().unwrap(), &[]), "rename", "x").unwrap();
        assert_eq!(renamed, "三体 (2).epub");
    }

    #[test]
    fn newer_progress_wins_and_merge_keeps_other_books() {
        let local = ReadPoint { cfi: "local".into(), fraction: 0.2, updated_ms: 10, section: None, char_offset: None };
        let cloud = ReadPoint { cfi: "cloud".into(), fraction: 0.8, updated_ms: 20, section: None, char_offset: None };
        assert_eq!(newer_point(Some(local.clone()), Some(cloud.clone())).unwrap().cfi, "cloud");
        assert_eq!(newer_point(Some(cloud.clone()), Some(local.clone())).unwrap().cfi, "cloud");
        let merged = merge_progress_json(r#"{"另一本.epub":{"cfi":"x","fraction":0.1,"updatedMs":1}}"#, "三体.epub", &local).unwrap();
        assert!(merged.contains("另一本.epub"));
        assert!(merged.contains("三体.epub"));
        assert!(merged.contains("local"));
    }
}
