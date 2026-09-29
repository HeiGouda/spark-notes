mod ai;
mod archive;
mod chat;
mod fsops;
mod git;
mod history;
mod webdav;
mod index;
mod notes;
mod secret;
mod vault;
mod watch;

use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};
use vault::{NoteFile, TreeNode};

/// 当前笔记库的索引连接（切换笔记库时重新打开）
#[derive(Default)]
struct IndexState(Mutex<Option<(PathBuf, Connection)>>);

/// 在后台线程里使用索引，避免首次建索引等耗时操作阻塞界面线程
async fn with_index<T: Send + 'static>(
    app: AppHandle,
    root: String,
    f: impl FnOnce(&mut Connection, &Path) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<IndexState>();
        let mut guard = state.0.lock().map_err(|_| "索引状态异常".to_string())?;
        let root = PathBuf::from(root);
        if guard.as_ref().map(|(r, _)| r != &root).unwrap_or(true) {
            *guard = Some((root.clone(), index::open(&root)?));
        }
        let (_, conn) = guard.as_mut().expect("just set");
        f(conn, &root)
    })
    .await
    .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
async fn vault_scan(root: String) -> Result<Vec<TreeNode>, String> {
    tauri::async_runtime::spawn_blocking(move || vault::scan(Path::new(&root)))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
fn vault_watch(app: AppHandle, state: tauri::State<'_, watch::WatchState>, root: String) -> Result<(), String> {
    watch::watch(app, &state, &root)
}

#[tauri::command]
async fn index_sync(app: AppHandle, root: String) -> Result<index::SyncStats, String> {
    with_index(app, root, index::sync).await
}

#[tauri::command]
async fn index_search(app: AppHandle, root: String, query: String, limit: usize) -> Result<Vec<index::SearchHit>, String> {
    with_index(app, root, move |c, _| index::search(c, &query, limit)).await
}

#[tauri::command]
async fn index_tags(app: AppHandle, root: String) -> Result<Vec<index::TagCount>, String> {
    with_index(app, root, |c, _| index::tags(c)).await
}

#[tauri::command]
async fn index_tag_notes(app: AppHandle, root: String, tag: String) -> Result<Vec<index::NoteRef>, String> {
    with_index(app, root, move |c, _| index::tag_notes(c, &tag)).await
}

#[tauri::command]
async fn link_backlinks(app: AppHandle, root: String, path: String) -> Result<Vec<index::Backlink>, String> {
    with_index(app, root, move |c, _| index::backlinks(c, &path)).await
}

/// 改名 / 移动之后、刷新索引之前调用，返回被改写的笔记
#[tauri::command]
async fn link_rewrite(app: AppHandle, root: String, from: String, to: String) -> Result<Vec<String>, String> {
    with_index(app, root, move |c, r| index::rewrite_links(c, r, &from, &to)).await
}

/// 打开笔记库时调用：只把这个笔记库目录加入 asset 协议白名单，用于显示笔记里的相对路径图片
#[tauri::command]
fn vault_allow_assets(app: tauri::AppHandle, root: String) -> Result<(), String> {
    let path = Path::new(&root);
    if !path.is_dir() {
        return Err(format!("笔记库目录不存在：{root}"));
    }
    app.asset_protocol_scope()
        .allow_directory(path, true)
        .map_err(|e| format!("放行附件目录失败：{e}"))
}

#[tauri::command]
fn note_read(root: String, path: String) -> Result<NoteFile, String> {
    vault::read_note(Path::new(&root), &path)
}

#[tauri::command]
fn note_write(root: String, path: String, content: String) -> Result<(), String> {
    let root_path = Path::new(&root);
    history::before_write(root_path, &path, &content)?;
    vault::write_note(root_path, &path, &content)
}

#[tauri::command]
fn history_list(root: String, path: String) -> Result<Vec<history::HistoryVersion>, String> {
    history::list(Path::new(&root), &path)
}

#[tauri::command]
fn history_read(root: String, path: String, id: String) -> Result<String, String> {
    history::read(Path::new(&root), &path, &id)
}

#[tauri::command]
fn history_snapshot(root: String, path: String) -> Result<(), String> {
    history::snapshot_now(Path::new(&root), &path)
}

#[tauri::command]
fn history_restore(root: String, path: String, id: String) -> Result<(), String> {
    history::restore(Path::new(&root), &path, &id)
}

#[tauri::command]
fn trash_list(root: String) -> Result<Vec<fsops::TrashItem>, String> {
    fsops::trash_list(Path::new(&root))
}

#[tauri::command]
fn trash_restore(root: String, id: String) -> Result<(), String> {
    fsops::trash_restore(Path::new(&root), &id)
}

#[tauri::command]
fn trash_delete(root: String, id: String) -> Result<(), String> {
    fsops::trash_delete(Path::new(&root), &id)
}

#[tauri::command]
async fn trash_empty(root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || fsops::trash_empty(Path::new(&root)))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
async fn retain_prune(root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&root);
        let (history_days, trash_days) = history::retention_days(root);
        history::prune(root, history_days)?;
        fsops::trash_prune(root, trash_days)
    })
    .await
    .map_err(|e| format!("后台任务失败：{e}"))?
}

fn resolve_webdav_password(root: &Path, password: &str) -> Result<String, String> {
    if !password.is_empty() {
        return Ok(password.to_string());
    }
    webdav::load_password(root)?.ok_or_else(|| "请先填写 WebDAV 密码".into())
}

#[tauri::command]
async fn webdav_test(root: String, url: String, remote_dir: String, username: String, password: String) -> Result<webdav::RemoteInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let password = resolve_webdav_password(Path::new(&root), &password)?;
        webdav::test_connection(&url, &remote_dir, &username, &password)
    })
    .await
    .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
async fn webdav_preview(root: String, url: String, remote_dir: String, username: String) -> Result<webdav::Preview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root_path = Path::new(&root);
        let password = resolve_webdav_password(root_path, "")?;
        webdav::preview_vault(root_path, &url, &remote_dir, &username, &password)
    })
    .await
    .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn webdav_run(
    root: String,
    url: String,
    remote_dir: String,
    username: String,
    direction: webdav::Direction,
    accept: Vec<String>,
    force: bool,
) -> Result<webdav::SyncReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root_path = Path::new(&root);
        let password = resolve_webdav_password(root_path, "")?;
        webdav::run_vault(root_path, &url, &remote_dir, &username, &password, direction, &accept, force)
    })
    .await
    .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
fn webdav_save_password(root: String, password: String) -> Result<(), String> {
    webdav::save_password(Path::new(&root), &password)
}

#[tauri::command]
fn webdav_has_password(root: String) -> Result<bool, String> {
    Ok(webdav::load_password(Path::new(&root))?.is_some_and(|p| !p.is_empty()))
}

#[tauri::command]
async fn vault_export_zip(root: String, dest: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || archive::export_zip(Path::new(&root), Path::new(&dest)))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
async fn vault_import_zip(zip_path: String, dest: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || archive::import_zip(Path::new(&zip_path), Path::new(&dest)))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
fn vault_create(parent: String, name: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) || name.starts_with('.') {
        return Err("笔记库名称无效".into());
    }
    let path = Path::new(&parent).join(name);
    if path.exists() {
        return Err("已存在同名文件夹".into());
    }
    std::fs::create_dir(&path).map_err(|e| format!("无法创建笔记库：{e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn note_create(root: String, dir: String, name: Option<String>) -> Result<String, String> {
    fsops::create_note(Path::new(&root), &dir, name.as_deref())
}

#[tauri::command]
fn folder_create(root: String, dir: String, name: Option<String>) -> Result<String, String> {
    fsops::create_folder(Path::new(&root), &dir, name.as_deref())
}

#[tauri::command]
fn entry_rename(root: String, path: String, name: String) -> Result<String, String> {
    let root = Path::new(&root);
    let rel = fsops::rename_entry(root, &path, &name)?;
    relocate_history(root, &path, &rel);
    Ok(rel)
}

/// 文件已经改名 / 移动成功，历史版本迁移失败不应让前端以为操作失败
fn relocate_history(root: &Path, from: &str, to: &str) {
    if let Err(e) = history::relocate(root, from, to) {
        eprintln!("{e}");
    }
}

#[tauri::command]
fn entry_move(root: String, path: String, target_dir: String) -> Result<String, String> {
    let root = Path::new(&root);
    let rel = fsops::move_entry(root, &path, &target_dir)?;
    relocate_history(root, &path, &rel);
    Ok(rel)
}

#[tauri::command]
fn entry_trash(root: String, path: String) -> Result<(), String> {
    fsops::trash_entry(Path::new(&root), &path)
}

fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| format!("无效编码：{s}"))?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

/// 附件内容以原始二进制传输，避免把大图片编码成 JSON 数组；参数放在请求头里（URL 编码）
#[tauri::command]
fn attachment_save(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("附件数据格式错误".into());
    };
    let header = |key: &str| -> Result<String, String> {
        let raw = request
            .headers()
            .get(key)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| format!("缺少参数 {key}"))?;
        percent_decode(raw)
    };
    fsops::save_attachment(Path::new(&header("x-root")?), &header("x-note")?, &header("x-name")?, bytes)
}

#[tauri::command]
fn attachment_import(root: String, note: String, source: String) -> Result<String, String> {
    fsops::import_attachment(Path::new(&root), &note, &source)
}

#[tauri::command]
fn vault_config_read(root: String, name: String) -> Result<Option<String>, String> {
    fsops::config_read(Path::new(&root), &name)
}

#[tauri::command]
fn vault_config_write(root: String, name: String, content: String) -> Result<(), String> {
    fsops::config_write(Path::new(&root), &name, &content)
}

#[tauri::command]
async fn git_status(root: String) -> Result<git::GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || git::status(Path::new(&root)))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
async fn git_log(root: String) -> Result<Vec<git::GitLogEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || git::log(Path::new(&root)))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
async fn git_init(root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git::init_repo(Path::new(&root)))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
async fn git_commit(root: String, message: String) -> Result<git::GitAction, String> {
    tauri::async_runtime::spawn_blocking(move || git::commit(Path::new(&root), &message))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
async fn git_auto_commit(root: String, prefix: String) -> Result<git::GitAction, String> {
    tauri::async_runtime::spawn_blocking(move || git::auto_commit(Path::new(&root), &prefix))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
async fn git_pull(root: String, local: git::LocalChanges) -> Result<git::GitAction, String> {
    tauri::async_runtime::spawn_blocking(move || git::pull(Path::new(&root), local))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
async fn git_push(root: String) -> Result<git::GitAction, String> {
    tauri::async_runtime::spawn_blocking(move || git::push(Path::new(&root)))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
async fn git_sync(root: String, local: git::LocalChanges) -> Result<git::GitAction, String> {
    tauri::async_runtime::spawn_blocking(move || git::sync(Path::new(&root), local))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
async fn git_set_identity(root: String, name: String, email: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git::set_identity(Path::new(&root), &name, &email))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
async fn git_set_remote(root: String, url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git::set_remote(Path::new(&root), &url))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
async fn git_connect(root: String, url: String, username: String, password: String) -> Result<git::ConnectResult, String> {
    tauri::async_runtime::spawn_blocking(move || git::connect(Path::new(&root), &url, &username, &password))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
fn git_set_credentials(root: String, username: String, password: String) -> Result<(), String> {
    git::set_credentials(Path::new(&root), &username, &password)
}

#[tauri::command]
async fn git_change_diff(root: String, max_chars: usize) -> Result<git::ChangeDiff, String> {
    tauri::async_runtime::spawn_blocking(move || git::change_diff(Path::new(&root), max_chars))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
fn ai_save_key(key: String) -> Result<(), String> {
    ai::save_key(&key)
}

#[tauri::command]
fn ai_has_key() -> Result<bool, String> {
    ai::has_key()
}

#[tauri::command]
fn ai_clear_key() -> Result<(), String> {
    ai::clear_key()
}

#[tauri::command]
async fn ai_test(base_url: String, model: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || ai::test(&base_url, &model))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

/// 流式对话：文字通过 on_event 逐段送回；请求结束（完成、取消或失败）时返回
#[tauri::command]
async fn ai_chat(
    app: AppHandle,
    id: String,
    base_url: String,
    model: String,
    messages: Vec<ai::ChatMessage>,
    on_event: tauri::ipc::Channel<ai::AiEvent>,
) -> Result<(), String> {
    let flag = app.state::<ai::AiState>().register(&id);
    let result = tauri::async_runtime::spawn_blocking(move || {
        ai::chat_stream(&base_url, &model, &messages, &flag, |text| {
            on_event.send(ai::AiEvent::Delta { text }).map_err(|e| format!("界面已关闭：{e}"))
        })
    })
    .await
    .map_err(|e| format!("后台任务失败：{e}"));
    app.state::<ai::AiState>().finish(&id);
    result?
}

#[tauri::command]
fn ai_cancel(state: tauri::State<'_, ai::AiState>, id: String) {
    state.cancel(&id);
}

#[tauri::command]
async fn ai_list_models(base_url: String) -> Result<Vec<ai::ProviderModel>, String> {
    tauri::async_runtime::spawn_blocking(move || ai::list_models(&base_url))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

/// AI 对话存放在应用数据目录的 ai-chats/，不进入笔记库
fn chats_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| format!("找不到应用数据目录：{e}"))?.join("ai-chats"))
}

#[tauri::command]
fn chat_list(app: AppHandle) -> Result<Vec<chat::ChatSummary>, String> {
    chat::list(&chats_dir(&app)?)
}

#[tauri::command]
fn chat_read(app: AppHandle, id: String) -> Result<String, String> {
    chat::read(&chats_dir(&app)?, &id)
}

#[tauri::command]
fn chat_write(app: AppHandle, id: String, json: String) -> Result<(), String> {
    chat::write(&chats_dir(&app)?, &id, &json)
}

#[tauri::command]
fn chat_delete(app: AppHandle, id: String) -> Result<(), String> {
    chat::delete(&chats_dir(&app)?, &id)
}

#[tauri::command]
fn chat_delete_image(app: AppHandle, id: String, file: String) -> Result<(), String> {
    chat::delete_image(&chats_dir(&app)?, &id, &file)
}

/// 粘贴或拖入的图片以原始二进制传输，参数放在请求头里（URL 编码）
#[tauri::command]
fn chat_save_image(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("图片数据格式错误".into());
    };
    let header = |key: &str| -> Result<String, String> {
        let raw = request.headers().get(key).and_then(|v| v.to_str().ok()).ok_or_else(|| format!("缺少参数 {key}"))?;
        percent_decode(raw)
    };
    chat::save_image(&chats_dir(&app)?, &header("x-chat")?, &header("x-name")?, bytes)
}

#[tauri::command]
fn chat_import_image(app: AppHandle, id: String, source: String) -> Result<String, String> {
    chat::import_image(&chats_dir(&app)?, &id, Path::new(&source))
}

#[tauri::command]
fn chat_image_data(app: AppHandle, id: String, file: String) -> Result<String, String> {
    chat::image_data(&chats_dir(&app)?, &id, &file)
}

/// 读写用户在对话框中选定的文本文件（快捷键配置的导入 / 导出）
#[tauri::command]
fn text_file_read(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败 {path}：{e}"))
}

#[tauri::command]
fn text_file_write(path: String, content: String) -> Result<(), String> {
    vault::atomic_write(Path::new(&path), &content)
}

/// macOS 菜单栏。网页里的 Cmd+C / V / X / A 要靠“编辑”菜单里的系统菜单项才生效；
/// 撤销 / 重做不放进来，交给编辑器自己的历史。
/// “退出”不用系统菜单项，改为通知前端走关闭窗口的流程，先保存未存盘的笔记。
#[cfg(target_os = "macos")]
fn mac_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出 Spark", true, Some("CmdOrCtrl+Q"))?;
    let app_menu = Submenu::with_items(
        app,
        "Spark",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("关于 Spark"), Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some("服务"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("隐藏 Spark"))?,
            &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
            &PredefinedMenuItem::show_all(app, Some("全部显示"))?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("复制"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("最小化"))?,
            &PredefinedMenuItem::maximize(app, Some("缩放"))?,
            &PredefinedMenuItem::fullscreen(app, Some("进入全屏幕"))?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}

#[cfg(target_os = "macos")]
const MENU_QUIT: &str = "app.quit";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(IndexState::default())
        .manage(watch::WatchState::default())
        .manage(ai::AiState::default());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(mac_menu).on_menu_event(|app, event| {
        use tauri::Emitter;
        if event.id() == MENU_QUIT {
            if let Err(e) = app.emit("app-quit-requested", ()) {
                eprintln!("通知退出失败：{e}");
            }
        }
    });
    builder
        .invoke_handler(tauri::generate_handler![
            vault_scan,
            vault_watch,
            index_sync,
            index_search,
            index_tags,
            index_tag_notes,
            link_backlinks,
            link_rewrite,
            text_file_read,
            text_file_write,
            vault_allow_assets,
            note_read,
            note_write,
            history_list,
            history_read,
            history_restore,
            history_snapshot,
            trash_list,
            trash_restore,
            trash_delete,
            trash_empty,
            retain_prune,
            webdav_test,
            webdav_preview,
            webdav_run,
            webdav_save_password,
            webdav_has_password,
            vault_export_zip,
            vault_import_zip,
            vault_create,
            note_create,
            folder_create,
            entry_rename,
            entry_move,
            entry_trash,
            attachment_save,
            attachment_import,
            vault_config_read,
            vault_config_write,
            git_status,
            git_log,
            git_init,
            git_commit,
            git_auto_commit,
            git_pull,
            git_push,
            git_sync,
            git_set_identity,
            git_set_remote,
            git_set_credentials,
            git_connect,
            git_change_diff,
            ai_save_key,
            ai_has_key,
            ai_clear_key,
            ai_test,
            ai_chat,
            ai_cancel,
            ai_list_models,
            chat_list,
            chat_read,
            chat_write,
            chat_delete,
            chat_delete_image,
            chat_save_image,
            chat_import_image,
            chat_image_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn percent_decode_utf8() {
        assert_eq!(percent_decode("%E5%91%A8%E6%8A%A5%20a.png").unwrap(), "周报 a.png");
        assert_eq!(percent_decode("C%3A%5Cvault").unwrap(), "C:\\vault");
        assert!(percent_decode("%ZZ").is_err());
    }
}
