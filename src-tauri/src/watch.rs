//! 监听笔记库文件变化（外部编辑器修改、同步工具写入等），合并后以 `vault-changed` 事件通知前端。

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(300);

#[derive(Default)]
pub struct WatchState(pub Mutex<Option<RecommendedWatcher>>);

fn relevant(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned());
    let first = parts.next()?;
    if first.starts_with('.') {
        return None;
    }
    let rel = std::iter::once(first).chain(parts).collect::<Vec<_>>().join("/");
    if rel.ends_with(".ttnote-tmp") {
        return None;
    }
    Some(rel)
}

/// 开始监听新的笔记库；旧的监听随之停止
pub fn watch(app: AppHandle, state: &WatchState, root: &str) -> Result<(), String> {
    let root = PathBuf::from(root);
    let (tx, rx) = channel::<Event>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(ev) = res {
            let _ = tx.send(ev);
        }
    })
    .map_err(|e| format!("无法监听笔记库变化：{e}"))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("无法监听笔记库变化：{e}"))?;

    std::thread::spawn(move || loop {
        let Ok(first) = rx.recv() else { return };
        let mut paths: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut add = |ev: Event| {
            for p in ev.paths {
                if let Some(rel) = relevant(&root, &p) {
                    if seen.insert(rel.clone()) {
                        paths.push(rel);
                    }
                }
            }
        };
        add(first);
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(ev) => add(ev),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        if !paths.is_empty() {
            let _ = app.emit("vault-changed", paths);
        }
    });

    *state.0.lock().map_err(|_| "监听状态异常".to_string())? = Some(watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::relevant;
    use std::path::Path;

    #[test]
    fn ignores_internal_and_temp_files() {
        let root = Path::new("C:/v");
        assert_eq!(relevant(root, Path::new("C:/v/工作/a.md")).as_deref(), Some("工作/a.md"));
        assert_eq!(relevant(root, Path::new("C:/v/.ttnote/cache/index.db")), None);
        assert_eq!(relevant(root, Path::new("C:/v/.a.md.ttnote-tmp")), None);
        assert_eq!(relevant(root, Path::new("C:/other/a.md")), None);
    }
}
