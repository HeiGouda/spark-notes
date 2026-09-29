//! 安卓只读版：多个笔记库，各自放在应用私有目录，只从 WebDAV 下载。
//! 笔记库列表在 `<应用数据>/mobile/vaults.json`，不含密码；本地副本在 `<应用数据>/mobile/vaults/<id>/`。

use crate::fsops;
use crate::vault::atomic_write;
use crate::webdav::{self, Dav, Direction, Preview, RemoteEntry, Step, SyncReport};
use serde::{Deserialize, Serialize};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultConfig {
    pub id: String,
    pub name: String,
    pub url: String,
    pub remote_dir: String,
    pub username: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInput {
    pub name: String,
    pub url: String,
    pub remote_dir: String,
    pub username: String,
}

fn list_path(base: &Path) -> PathBuf {
    base.join("mobile").join("vaults.json")
}

fn vaults_dir(base: &Path) -> PathBuf {
    base.join("mobile").join("vaults")
}

pub fn list_vaults(base: &Path) -> Result<Vec<VaultConfig>, String> {
    match fs::read_to_string(list_path(base)) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("笔记库列表损坏：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("读取笔记库列表失败：{e}")),
    }
}

fn save_vaults(base: &Path, vaults: &[VaultConfig]) -> Result<(), String> {
    let path = list_path(base);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建应用数据目录失败：{e}"))?;
    }
    atomic_write(&path, &serde_json::to_string_pretty(vaults).map_err(|e| e.to_string())?)
}

fn clean_input(input: &VaultInput) -> Result<VaultInput, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("请填写笔记库名称".into());
    }
    Ok(VaultInput {
        name: name.to_string(),
        url: input.url.trim().to_string(),
        remote_dir: input.remote_dir.trim().to_string(),
        username: input.username.trim().to_string(),
    })
}

fn new_id(taken: &[VaultConfig]) -> String {
    let mut n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    loop {
        let id = format!("{n:x}");
        if !taken.iter().any(|v| v.id == id) {
            return id;
        }
        n += 1;
    }
}

pub fn add_vault(base: &Path, input: &VaultInput) -> Result<VaultConfig, String> {
    let input = clean_input(input)?;
    let mut vaults = list_vaults(base)?;
    let vault = VaultConfig { id: new_id(&vaults), name: input.name, url: input.url, remote_dir: input.remote_dir, username: input.username };
    let root = vaults_dir(base).join(&vault.id);
    fs::create_dir_all(&root).map_err(|e| format!("创建笔记库目录失败：{e}"))?;
    vaults.push(vault.clone());
    save_vaults(base, &vaults)?;
    Ok(vault)
}

/// 地址或远端目录变了，本地副本和同步记录都属于原来的云端，清空后下次同步重新下载
pub fn update_vault(base: &Path, id: &str, input: &VaultInput) -> Result<VaultConfig, String> {
    let input = clean_input(input)?;
    let root = vault_root(base, id)?;
    let mut vaults = list_vaults(base)?;
    let vault = vaults.iter_mut().find(|v| v.id == id).ok_or("没有这个笔记库")?;
    let moved = vault.url != input.url || vault.remote_dir != input.remote_dir;
    *vault = VaultConfig { id: id.to_string(), name: input.name, url: input.url, remote_dir: input.remote_dir, username: input.username };
    let updated = vault.clone();
    save_vaults(base, &vaults)?;
    if moved {
        if root.exists() {
            fs::remove_dir_all(&root).map_err(|e| format!("清空本地副本失败：{e}"))?;
        }
        fs::create_dir_all(&root).map_err(|e| format!("创建笔记库目录失败：{e}"))?;
    }
    Ok(updated)
}

/// 配置和本地副本一起删除；云端不受影响
pub fn remove_vault(base: &Path, id: &str) -> Result<(), String> {
    let mut vaults = list_vaults(base)?;
    let root = vault_root(base, id)?;
    vaults.retain(|v| v.id != id);
    save_vaults(base, &vaults)?;
    if root.exists() {
        fs::remove_dir_all(&root).map_err(|e| format!("删除本地副本失败：{e}"))?;
    }
    Ok(())
}

/// 只接受列表里已有的 id，避免拼出笔记库目录以外的路径
pub fn vault_root(base: &Path, id: &str) -> Result<PathBuf, String> {
    if !list_vaults(base)?.iter().any(|v| v.id == id) {
        return Err("没有这个笔记库".into());
    }
    Ok(vaults_dir(base).join(id))
}

/// 只转发读操作的 WebDAV。手机端永远不写服务器，写操作一律报错。
pub struct ReadOnlyDav<D: Dav> {
    inner: D,
    /// 最近一次列目录时各文件的大小，用来估算下载量
    sizes: RefCell<HashMap<String, u64>>,
}

impl<D: Dav> ReadOnlyDav<D> {
    pub fn new(inner: D) -> Self {
        Self { inner, sizes: RefCell::new(HashMap::new()) }
    }
}

const READ_ONLY: &str = "手机端只读，不会写入云端";

impl<D: Dav> Dav for ReadOnlyDav<D> {
    fn list(&self) -> Result<Vec<RemoteEntry>, String> {
        let entries = self.inner.list()?;
        *self.sizes.borrow_mut() = entries.iter().filter_map(|e| Some((e.rel.clone(), e.size?))).collect();
        Ok(entries)
    }
    fn get(&self, rel: &str) -> Result<Vec<u8>, String> {
        self.inner.get(rel)
    }
    fn put(&self, _rel: &str, _bytes: &[u8]) -> Result<String, String> {
        Err(READ_ONLY.into())
    }
    fn delete(&self, _rel: &str) -> Result<(), String> {
        Err(READ_ONLY.into())
    }
    fn ensure_dir(&self, _rel: &str) -> Result<(), String> {
        Err(READ_ONLY.into())
    }
    fn move_to(&self, _from: &str, _to: &str) -> Result<(), String> {
        Err(READ_ONLY.into())
    }
    fn ensure_root(&self) -> Result<(), String> {
        Err(READ_ONLY.into())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncCheck {
    /// 这个笔记库还没完整同步过
    pub first_sync: bool,
    pub downloads: u32,
    /// 要下载的文件总大小（字节）。服务器没给大小的文件不计入
    pub download_bytes: u64,
    /// 云端已删除、本地要跟着删除的文件
    pub removals: Vec<String>,
    /// 云端文件突然少了很多时的提示
    pub guard: Option<String>,
    pub needs_confirm: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SyncOutcome {
    /// 删除太多或云端异常，把 `check.removals` 交给用户确认后再调 `sync`。
    /// 只是删除太多时，新增和修改已经下载（`report`）；云端异常时什么都没做
    NeedsConfirm { check: SyncCheck, report: Option<SyncReport> },
    Done { report: SyncReport },
}

/// 下载进度：开始时先发一次 `done == 0`，之后每下载一个文件发一次
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: u32,
    pub total: u32,
    pub rel: String,
}

/// 同步执行期间统计下载了几个文件
struct Counting<'a> {
    inner: &'a dyn Dav,
    total: u32,
    done: Cell<u32>,
    progress: &'a dyn Fn(Progress),
}

impl Dav for Counting<'_> {
    fn list(&self) -> Result<Vec<RemoteEntry>, String> {
        self.inner.list()
    }
    fn get(&self, rel: &str) -> Result<Vec<u8>, String> {
        let bytes = self.inner.get(rel)?;
        let done = (self.done.get() + 1).min(self.total);
        self.done.set(done);
        (self.progress)(Progress { done, total: self.total, rel: rel.to_string() });
        Ok(bytes)
    }
    fn put(&self, rel: &str, bytes: &[u8]) -> Result<String, String> {
        self.inner.put(rel, bytes)
    }
    fn delete(&self, rel: &str) -> Result<(), String> {
        self.inner.delete(rel)
    }
    fn ensure_dir(&self, rel: &str) -> Result<(), String> {
        self.inner.ensure_dir(rel)
    }
    fn move_to(&self, from: &str, to: &str) -> Result<(), String> {
        self.inner.move_to(from, to)
    }
    fn ensure_root(&self) -> Result<(), String> {
        self.inner.ensure_root()
    }
}

/// 一次删除超过这么多文件，或超过本地文件数的十分之一，要先确认
const MAX_SILENT_REMOVALS: usize = 20;

fn items_with(preview: &Preview, step: Step) -> Vec<String> {
    preview.download.iter().filter(|i| i.step == step).map(|i| i.rel.clone()).collect()
}

pub fn check<D: Dav>(root: &Path, dav: &ReadOnlyDav<D>) -> Result<SyncCheck, String> {
    inspect(root, dav).map(|(c, _)| c)
}

/// 同时返回需要覆盖的本地文件：本地从不编辑，出现冲突时以云端为准
fn inspect<D: Dav>(root: &Path, dav: &ReadOnlyDav<D>) -> Result<(SyncCheck, Vec<String>), String> {
    let preview = webdav::preview(root, dav)?;
    let sizes = dav.sizes.borrow();
    let fetched: Vec<&str> = preview
        .download
        .iter()
        .filter(|i| matches!(i.step, Step::Add | Step::Update | Step::Overwrite))
        .map(|i| i.rel.as_str())
        .collect();
    let removals = items_with(&preview, Step::Remove);
    let c = SyncCheck {
        first_sync: preview.last_sync_ms == 0,
        downloads: fetched.len() as u32,
        download_bytes: fetched.iter().filter_map(|rel| sizes.get(*rel)).sum(),
        needs_confirm: preview.guard.is_some()
            || removals.len() > MAX_SILENT_REMOVALS
            || removals.len() * 10 > preview.local_files as usize,
        removals,
        guard: preview.guard.clone(),
    };
    Ok((c, items_with(&preview, Step::Overwrite)))
}

/// 让本地副本与云端一致。需要确认时，只有 `confirmed` 覆盖了全部待删文件才删除；
/// 没确认时仍下载新增和修改，但云端异常（`guard`）时什么都不做。
pub fn sync<D: Dav>(root: &Path, dav: &ReadOnlyDav<D>, confirmed: &[String], progress: &dyn Fn(Progress)) -> Result<SyncOutcome, String> {
    let (c, mut accept) = inspect(root, dav)?;
    let held = c.needs_confirm && !c.removals.iter().all(|r| confirmed.contains(r));
    if held && c.guard.is_some() {
        return Ok(SyncOutcome::NeedsConfirm { check: c, report: None });
    }
    if !held {
        accept.extend(c.removals.iter().cloned());
    }
    progress(Progress { done: 0, total: c.downloads, rel: String::new() });
    let counting = Counting { inner: dav, total: c.downloads, done: Cell::new(0), progress };
    let report = webdav::run(root, &counting, Direction::Download, &accept, c.guard.is_some(), 0)?;
    drop_local_backups(root)?;
    Ok(if held { SyncOutcome::NeedsConfirm { check: c, report: Some(report) } } else { SyncOutcome::Done { report } })
}

/// 同步时被删除、覆盖的本地文件会进回收站和历史版本；手机上用不到，云端和电脑上都还有，直接清掉省空间
fn drop_local_backups(root: &Path) -> Result<(), String> {
    fsops::trash_empty(root)?;
    let history = root.join(".ttnote").join("history");
    if history.exists() {
        fs::remove_dir_all(&history).map_err(|e| format!("清理历史版本失败：{e}"))?;
    }
    Ok(())
}

/// 前端调用的命令。都在后台线程执行：读写密码要等 Kotlin 返回，不能占着界面线程。
#[cfg(target_os = "android")]
pub mod commands {
    use super::*;
    use crate::secret::{delete_secret, read_secret, write_secret};
    use crate::webdav::UreqDav;
    use tauri::{AppHandle, Manager};

    async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
        tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("后台任务失败：{e}"))?
    }

    fn base(app: &AppHandle) -> Result<PathBuf, String> {
        app.path().app_data_dir().map_err(|e| format!("找不到应用数据目录：{e}"))
    }

    fn account(id: &str) -> String {
        format!("Spark:mobile:{id}")
    }

    fn find(base: &Path, id: &str) -> Result<VaultConfig, String> {
        list_vaults(base)?.into_iter().find(|v| v.id == id).ok_or_else(|| "没有这个笔记库".into())
    }

    /// 连得上、账号正确、远端目录存在，才允许保存
    fn verify(input: &VaultInput, password: &str) -> Result<(), String> {
        let info = webdav::test_connection(input.url.trim(), input.remote_dir.trim(), input.username.trim(), password)?;
        if info.missing {
            return Err("云端没有这个目录，请检查远端目录".into());
        }
        Ok(())
    }

    fn open(base: &Path, id: &str) -> Result<(PathBuf, ReadOnlyDav<UreqDav>), String> {
        let v = find(base, id)?;
        let password = read_secret(&account(id))?.ok_or("没有保存密码，请在「我的」里重新填写")?;
        let dav = UreqDav::new(&v.url, &v.remote_dir, &v.username, &password)?;
        Ok((vault_root(base, id)?, ReadOnlyDav::new(dav)))
    }

    #[tauri::command]
    pub async fn mobile_vault_list(app: AppHandle) -> Result<Vec<VaultConfig>, String> {
        blocking(move || list_vaults(&base(&app)?)).await
    }

    /// 本地副本的目录，给浏览、搜索、读笔记等已有命令用
    #[tauri::command]
    pub async fn mobile_vault_root(app: AppHandle, id: String) -> Result<String, String> {
        blocking(move || Ok(vault_root(&base(&app)?, &id)?.to_string_lossy().into_owned())).await
    }

    #[tauri::command]
    pub async fn mobile_vault_add(app: AppHandle, input: VaultInput, password: String) -> Result<VaultConfig, String> {
        blocking(move || {
            verify(&input, &password)?;
            let base = base(&app)?;
            let vault = add_vault(&base, &input)?;
            if let Err(e) = write_secret(&account(&vault.id), &password) {
                let _ = remove_vault(&base, &vault.id);
                return Err(e);
            }
            Ok(vault)
        })
        .await
    }

    /// `password` 为空表示沿用已保存的密码
    #[tauri::command]
    pub async fn mobile_vault_update(app: AppHandle, id: String, input: VaultInput, password: String) -> Result<VaultConfig, String> {
        blocking(move || {
            let base = base(&app)?;
            find(&base, &id)?;
            let password = if password.is_empty() { read_secret(&account(&id))?.unwrap_or_default() } else { password };
            verify(&input, &password)?;
            let vault = update_vault(&base, &id, &input)?;
            write_secret(&account(&id), &password)?;
            Ok(vault)
        })
        .await
    }

    /// 删除配置、密码和本地副本；云端和电脑上的笔记不受影响
    #[tauri::command]
    pub async fn mobile_vault_remove(app: AppHandle, id: String) -> Result<(), String> {
        blocking(move || {
            remove_vault(&base(&app)?, &id)?;
            delete_secret(&account(&id))
        })
        .await
    }

    #[tauri::command]
    pub async fn mobile_sync_check(app: AppHandle, id: String) -> Result<SyncCheck, String> {
        blocking(move || {
            let (root, dav) = open(&base(&app)?, &id)?;
            check(&root, &dav)
        })
        .await
    }

    /// 不保存，只测试连接。`id` 有值且 `password` 为空时用已保存的密码
    #[tauri::command]
    pub async fn mobile_vault_test(id: Option<String>, input: VaultInput, password: String) -> Result<webdav::RemoteInfo, String> {
        blocking(move || {
            let password = match (&id, password.is_empty()) {
                (Some(id), true) => read_secret(&account(id))?.unwrap_or_default(),
                _ => password,
            };
            let info = webdav::test_connection(input.url.trim(), input.remote_dir.trim(), input.username.trim(), &password)?;
            if info.missing {
                return Err("云端没有这个目录，请检查远端目录".into());
            }
            Ok(info)
        })
        .await
    }

    /// 下载过文件就刷新搜索索引
    #[tauri::command]
    pub async fn mobile_sync(
        app: AppHandle,
        id: String,
        confirmed: Vec<String>,
        on_progress: tauri::ipc::Channel<Progress>,
    ) -> Result<SyncOutcome, String> {
        let handle = app.clone();
        let (root, outcome) = blocking(move || {
            let (root, dav) = open(&base(&handle)?, &id)?;
            let outcome = sync(&root, &dav, &confirmed, &|p| {
                let _ = on_progress.send(p);
            })?;
            Ok((root, outcome))
        })
        .await?;
        if matches!(outcome, SyncOutcome::Done { .. } | SyncOutcome::NeedsConfirm { report: Some(_), .. }) {
            crate::with_index(app, root.to_string_lossy().into_owned(), crate::index::sync).await?;
        }
        Ok(outcome)
    }

    #[tauri::command]
    pub async fn mobile_network_metered() -> Result<bool, String> {
        blocking(crate::secret_android::network_metered).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::webdav::hash_bytes;
    use std::collections::{BTreeMap, BTreeSet};

    /// 内存里的云端，记下收到的写请求次数
    struct Cloud {
        files: RefCell<BTreeMap<String, Vec<u8>>>,
        writes: Cell<u32>,
    }

    impl Cloud {
        fn new(files: &[(&str, &str)]) -> Self {
            let map = files.iter().map(|(k, v)| (k.to_string(), v.as_bytes().to_vec())).collect();
            Self { files: RefCell::new(map), writes: Cell::new(0) }
        }
        fn set(&self, rel: &str, text: &str) {
            self.files.borrow_mut().insert(rel.into(), text.as_bytes().to_vec());
        }
        fn remove(&self, rel: &str) {
            self.files.borrow_mut().remove(rel);
        }
        fn wrote(&self) -> Result<(), String> {
            self.writes.set(self.writes.get() + 1);
            Ok(())
        }
    }

    impl Dav for &Cloud {
        fn list(&self) -> Result<Vec<RemoteEntry>, String> {
            let files = self.files.borrow();
            let mut dirs = BTreeSet::new();
            for rel in files.keys() {
                let parts: Vec<&str> = rel.split('/').collect();
                for i in 1..parts.len() {
                    dirs.insert(parts[..i].join("/"));
                }
            }
            let mut out: Vec<RemoteEntry> =
                dirs.into_iter().map(|rel| RemoteEntry { rel, etag: String::new(), is_dir: true, size: None, modified: String::new() }).collect();
            out.extend(files.iter().map(|(rel, bytes)| RemoteEntry {
                rel: rel.clone(),
                etag: hash_bytes(bytes),
                is_dir: false,
                size: Some(bytes.len() as u64),
                modified: String::new(),
            }));
            Ok(out)
        }
        fn get(&self, rel: &str) -> Result<Vec<u8>, String> {
            self.files.borrow().get(rel).cloned().ok_or_else(|| "没有这个远端文件".into())
        }
        fn put(&self, _rel: &str, _bytes: &[u8]) -> Result<String, String> {
            self.wrote().map(|_| String::new())
        }
        fn delete(&self, _rel: &str) -> Result<(), String> {
            self.wrote()
        }
        fn ensure_dir(&self, _rel: &str) -> Result<(), String> {
            self.wrote()
        }
        fn move_to(&self, _from: &str, _to: &str) -> Result<(), String> {
            self.wrote()
        }
        fn ensure_root(&self) -> Result<(), String> {
            self.wrote()
        }
    }

    fn go<D: Dav>(root: &Path, dav: &ReadOnlyDav<D>, confirmed: &[String]) -> Result<SyncOutcome, String> {
        sync(root, dav, confirmed, &|_| {})
    }

    fn done(outcome: SyncOutcome) -> SyncReport {
        match outcome {
            SyncOutcome::Done { report } => report,
            SyncOutcome::NeedsConfirm { check, .. } => panic!("不该要求确认：{check:?}"),
        }
    }

    #[test]
    fn held_deletions_still_bring_in_other_changes() {
        let (tmp, cloud) = synced(300);
        let gone: Vec<String> = (0..21).map(|i| format!("笔记{i:02}.md")).collect();
        for rel in &gone {
            cloud.remove(rel);
        }
        cloud.set("笔记50.md", "电脑上改过");
        cloud.set("新的.md", "新");
        match go(tmp.path(), &ReadOnlyDav::new(&cloud), &[]).unwrap() {
            SyncOutcome::NeedsConfirm { check, report } => {
                assert_eq!(check.removals, gone);
                assert_eq!(report.map(|r| r.downloaded), Some(2));
            }
            SyncOutcome::Done { report } => panic!("应该先确认删除：{report:?}"),
        }
        assert_eq!(read(tmp.path(), "笔记50.md"), "电脑上改过");
        assert_eq!(read(tmp.path(), "新的.md"), "新");
        assert!(gone.iter().all(|rel| tmp.path().join(rel).is_file()));
        assert!(no_leftovers(tmp.path()));
    }

    #[test]
    fn reports_progress_for_each_downloaded_file() {
        let tmp = tempfile::tempdir().unwrap();
        let cloud = Cloud::new(&[("a.md", "1"), ("b/c.md", "2"), ("d.md", "3")]);
        let seen = RefCell::new(Vec::new());
        sync(tmp.path(), &ReadOnlyDav::new(&cloud), &[], &|p: Progress| seen.borrow_mut().push((p.done, p.total, p.rel))).unwrap();
        let expected: Vec<(u32, u32, String)> =
            vec![(0, 3, "".into()), (1, 3, "a.md".into()), (2, 3, "b/c.md".into()), (3, 3, "d.md".into())];
        assert_eq!(seen.into_inner(), expected);
    }

    fn read(root: &Path, rel: &str) -> String {
        fs::read_to_string(root.join(rel)).unwrap()
    }

    #[test]
    fn first_sync_reports_size_then_downloads_everything() {
        let tmp = tempfile::tempdir().unwrap();
        let cloud = Cloud::new(&[("周报.md", "你好"), ("工作/会议.md", "纪要"), ("周报.assets/a.png", "0123456789")]);
        let dav = ReadOnlyDav::new(&cloud);

        let c = check(tmp.path(), &dav).unwrap();
        assert!(c.first_sync);
        assert_eq!((c.downloads, c.download_bytes), (3, 22));
        assert!(!c.needs_confirm && c.removals.is_empty());

        let report = done(go(tmp.path(), &dav, &[]).unwrap());
        assert_eq!(report.downloaded, 3, "{report:?}");
        assert_eq!(read(tmp.path(), "工作/会议.md"), "纪要");
        assert_eq!(read(tmp.path(), "周报.assets/a.png"), "0123456789");

        let again = check(tmp.path(), &dav).unwrap();
        assert!(!again.first_sync);
        assert_eq!(again.downloads, 0);
    }

    #[test]
    fn never_writes_to_the_server() {
        let tmp = tempfile::tempdir().unwrap();
        let cloud = Cloud::new(&[("a.md", "一"), ("b.md", "二")]);
        let dav = ReadOnlyDav::new(&cloud);
        done(go(tmp.path(), &dav, &[]).unwrap());
        cloud.set("a.md", "改了");
        cloud.remove("b.md");
        cloud.set("c.md", "三");
        done(go(tmp.path(), &dav, &["b.md".into()]).unwrap());
        assert!(!tmp.path().join("b.md").exists());
        assert_eq!(cloud.writes.get(), 0);

        assert!(dav.put("a.md", b"x").is_err());
        assert!(dav.delete("a.md").is_err());
        assert!(dav.ensure_dir("x").is_err());
        assert!(dav.move_to("a.md", "b.md").is_err());
        assert!(dav.ensure_root().is_err());
        assert_eq!(cloud.writes.get(), 0);
    }

    /// 云端有 `n` 篇笔记，已完整同步到本地
    fn synced(n: usize) -> (tempfile::TempDir, Cloud) {
        let tmp = tempfile::tempdir().unwrap();
        let names: Vec<(String, String)> = (0..n).map(|i| (format!("笔记{i:02}.md"), format!("内容{i}"))).collect();
        let pairs: Vec<(&str, &str)> = names.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let cloud = Cloud::new(&pairs);
        done(go(tmp.path(), &ReadOnlyDav::new(&cloud), &[]).unwrap());
        (tmp, cloud)
    }

    fn no_leftovers(root: &Path) -> bool {
        let empty = |dir: &str| fs::read_dir(root.join(".ttnote").join(dir)).map(|mut d| d.next().is_none()).unwrap_or(true);
        empty("trash") && empty("history")
    }

    #[test]
    fn a_few_cloud_deletions_are_applied_without_asking() {
        let (tmp, cloud) = synced(30);
        cloud.remove("笔记00.md");
        cloud.remove("笔记01.md");
        cloud.remove("笔记02.md");
        let dav = ReadOnlyDav::new(&cloud);
        let c = check(tmp.path(), &dav).unwrap();
        assert!(!c.needs_confirm, "{c:?}");
        let report = done(go(tmp.path(), &dav, &[]).unwrap());
        assert_eq!(report.local_trashed, 3, "{report:?}");
        assert!(!tmp.path().join("笔记00.md").exists());
        assert!(tmp.path().join("笔记03.md").is_file());
        assert!(no_leftovers(tmp.path()));
    }

    #[test]
    fn more_than_twenty_deletions_wait_for_confirmation() {
        let (tmp, cloud) = synced(300);
        let gone: Vec<String> = (0..21).map(|i| format!("笔记{i:02}.md")).collect();
        for rel in &gone {
            cloud.remove(rel);
        }
        let dav = ReadOnlyDav::new(&cloud);
        let asked = match go(tmp.path(), &dav, &[]).unwrap() {
            SyncOutcome::NeedsConfirm { check, .. } => check,
            SyncOutcome::Done { report } => panic!("应该先确认：{report:?}"),
        };
        assert_eq!(asked.removals, gone);
        assert!(gone.iter().all(|rel| tmp.path().join(rel).is_file()));

        let report = done(go(tmp.path(), &dav, &asked.removals).unwrap());
        assert_eq!(report.local_trashed, 21, "{report:?}");
        assert!(gone.iter().all(|rel| !tmp.path().join(rel).exists()));
    }

    #[test]
    fn deleting_over_a_tenth_of_the_vault_waits_for_confirmation() {
        let (tmp, cloud) = synced(30);
        for i in 0..4 {
            cloud.remove(&format!("笔记{i:02}.md"));
        }
        let c = check(tmp.path(), &ReadOnlyDav::new(&cloud)).unwrap();
        assert!(c.needs_confirm && c.guard.is_none(), "{c:?}");
        assert_eq!(c.removals.len(), 4);
    }

    #[test]
    fn empty_cloud_listing_always_asks_even_for_one_file() {
        let (tmp, cloud) = synced(1);
        cloud.remove("笔记00.md");
        let dav = ReadOnlyDav::new(&cloud);
        let asked = match go(tmp.path(), &dav, &[]).unwrap() {
            SyncOutcome::NeedsConfirm { check, report } => {
                assert!(report.is_none(), "云端异常时什么都不该做：{report:?}");
                check
            }
            SyncOutcome::Done { report } => panic!("应该先确认：{report:?}"),
        };
        assert!(asked.guard.as_deref().is_some_and(|g| g.contains("云端目录是空的")), "{asked:?}");
        assert!(tmp.path().join("笔记00.md").is_file());

        done(go(tmp.path(), &dav, &asked.removals).unwrap());
        assert!(!tmp.path().join("笔记00.md").exists());
    }

    #[test]
    fn updated_notes_leave_no_history_versions() {
        let (tmp, cloud) = synced(3);
        cloud.set("笔记00.md", "电脑上改过");
        let report = done(go(tmp.path(), &ReadOnlyDav::new(&cloud), &[]).unwrap());
        assert_eq!(report.downloaded, 1, "{report:?}");
        assert_eq!(read(tmp.path(), "笔记00.md"), "电脑上改过");
        assert!(no_leftovers(tmp.path()));
    }

    #[test]
    fn downloaded_notes_are_searchable_and_removed_ones_drop_out() {
        let tmp = tempfile::tempdir().unwrap();
        let cloud = Cloud::new(&[("工作/坚果云同步.md", "用坚果云在电脑之间同步"), ("日记.md", "今天")]);
        let dav = ReadOnlyDav::new(&cloud);
        done(go(tmp.path(), &dav, &[]).unwrap());
        let mut conn = crate::index::open(tmp.path()).unwrap();
        crate::index::sync(&mut conn, tmp.path()).unwrap();
        let hits: Vec<String> = crate::index::search(&conn, "坚果云", 10).unwrap().into_iter().map(|h| h.path).collect();
        assert_eq!(hits, vec!["工作/坚果云同步.md"]);

        cloud.remove("工作/坚果云同步.md");
        done(go(tmp.path(), &dav, &["工作/坚果云同步.md".into()]).unwrap());
        crate::index::sync(&mut conn, tmp.path()).unwrap();
        assert!(crate::index::search(&conn, "坚果云", 10).unwrap().is_empty());
    }

    fn input(name: &str, url: &str) -> VaultInput {
        VaultInput { name: name.into(), url: url.into(), remote_dir: "笔记".into(), username: "me".into() }
    }

    #[test]
    fn each_vault_has_its_own_folder_and_removing_one_leaves_the_other() {
        let tmp = tempfile::tempdir().unwrap();
        let work = add_vault(tmp.path(), &input("工作", "https://dav.example.com")).unwrap();
        let home = add_vault(tmp.path(), &input("个人", "https://dav.example.com")).unwrap();
        assert_ne!(work.id, home.id);
        let work_root = vault_root(tmp.path(), &work.id).unwrap();
        let home_root = vault_root(tmp.path(), &home.id).unwrap();
        assert_ne!(work_root, home_root);
        fs::write(work_root.join("周报.md"), "工作").unwrap();
        fs::write(home_root.join("日记.md"), "个人").unwrap();

        remove_vault(tmp.path(), &work.id).unwrap();
        assert!(!work_root.exists());
        assert_eq!(list_vaults(tmp.path()).unwrap(), vec![home.clone()]);
        assert_eq!(fs::read_to_string(home_root.join("日记.md")).unwrap(), "个人");
        assert!(vault_root(tmp.path(), &work.id).is_err());
    }

    #[test]
    fn renaming_keeps_local_copy_but_pointing_elsewhere_clears_it() {
        let tmp = tempfile::tempdir().unwrap();
        let v = add_vault(tmp.path(), &input("工作", "https://dav.example.com")).unwrap();
        let root = vault_root(tmp.path(), &v.id).unwrap();
        fs::write(root.join("周报.md"), "工作").unwrap();

        let renamed = update_vault(tmp.path(), &v.id, &input("公司", "https://dav.example.com")).unwrap();
        assert_eq!((renamed.id.as_str(), renamed.name.as_str()), (v.id.as_str(), "公司"));
        assert!(root.join("周报.md").is_file());

        update_vault(tmp.path(), &v.id, &input("公司", "https://other.example.com")).unwrap();
        assert!(root.is_dir());
        assert!(!root.join("周报.md").exists());
        assert_eq!(list_vaults(tmp.path()).unwrap()[0].url, "https://other.example.com");
    }
}
