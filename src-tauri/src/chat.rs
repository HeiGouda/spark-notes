//! AI 对话的本机存储（需求文档 5.17）：应用数据目录下的 ai-chats/，
//! 每个会话一个 `<id>.json`（内容由前端定义），图片放在同名文件夹 `<id>/` 里。不随笔记库同步。

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::vault::atomic_write;
use crate::webdav::base64_encode;

/// 单张图片的大小上限
pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const IMAGE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn check_id(id: &str) -> Result<(), String> {
    if valid_id(id) { Ok(()) } else { Err("无效的会话 id".into()) }
}

fn json_path(base: &Path, id: &str) -> PathBuf {
    base.join(format!("{id}.json"))
}

pub fn list(base: &Path) -> Result<Vec<ChatSummary>, String> {
    let Ok(entries) = fs::read_dir(base) else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取会话列表失败：{e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".json") else { continue };
        if !valid_id(id) {
            continue;
        }
        let parsed = fs::read_to_string(entry.path()).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok());
        let summary = match parsed {
            Some(v) => ChatSummary {
                id: id.to_string(),
                title: v["title"].as_str().unwrap_or("新对话").to_string(),
                updated_at: v["updatedAt"].as_i64().unwrap_or(0),
            },
            // 损坏的会话也列出来，让用户能看到并删除
            None => ChatSummary { id: id.to_string(), title: "（无法读取的会话）".into(), updated_at: 0 },
        };
        out.push(summary);
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    Ok(out)
}

pub fn read(base: &Path, id: &str) -> Result<String, String> {
    check_id(id)?;
    fs::read_to_string(json_path(base, id)).map_err(|e| format!("读取会话失败：{e}"))
}

pub fn write(base: &Path, id: &str, json: &str) -> Result<(), String> {
    check_id(id)?;
    serde_json::from_str::<Value>(json).map_err(|e| format!("会话数据格式错误：{e}"))?;
    fs::create_dir_all(base).map_err(|e| format!("创建会话目录失败：{e}"))?;
    atomic_write(&json_path(base, id), json)
}

pub fn delete_image(base: &Path, id: &str, file: &str) -> Result<(), String> {
    check_id(id)?;
    if file.contains(['/', '\\']) || file.contains("..") || ext_of(file).is_none() {
        return Err("无效的图片文件名".into());
    }
    let path = base.join(id).join(file);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除图片失败：{e}"))?;
    }
    Ok(())
}

pub fn delete(base: &Path, id: &str) -> Result<(), String> {
    check_id(id)?;
    let file = json_path(base, id);
    if file.exists() {
        fs::remove_file(&file).map_err(|e| format!("删除会话失败：{e}"))?;
    }
    let dir = base.join(id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("删除会话图片失败：{e}"))?;
    }
    Ok(())
}

fn ext_of(name: &str) -> Option<String> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    IMAGE_EXTS.contains(&ext.as_str()).then_some(ext)
}

/// 保存一张图片，返回在会话文件夹里的文件名
pub fn save_image(base: &Path, id: &str, name: &str, bytes: &[u8]) -> Result<String, String> {
    check_id(id)?;
    let ext = ext_of(name).ok_or_else(|| format!("不支持的图片格式：{name}（支持 png、jpg、gif、webp）"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!("图片太大：{name}（上限 {} MB）", MAX_IMAGE_BYTES / 1024 / 1024));
    }
    let dir = base.join(id);
    fs::create_dir_all(&dir).map_err(|e| format!("创建会话图片目录失败：{e}"))?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let mut seq = 0u32;
    let file = loop {
        let candidate = format!("{stamp}-{seq}.{ext}");
        if !dir.join(&candidate).exists() {
            break candidate;
        }
        seq += 1;
    };
    fs::write(dir.join(&file), bytes).map_err(|e| format!("保存图片失败：{e}"))?;
    Ok(file)
}

pub fn import_image(base: &Path, id: &str, source: &Path) -> Result<String, String> {
    let name = source.file_name().and_then(|n| n.to_str()).unwrap_or("image").to_string();
    ext_of(&name).ok_or_else(|| format!("不支持的图片格式：{name}（支持 png、jpg、gif、webp）"))?;
    let len = fs::metadata(source).map_err(|e| format!("读取图片失败 {name}：{e}"))?.len();
    if len as usize > MAX_IMAGE_BYTES {
        return Err(format!("图片太大：{name}（上限 {} MB）", MAX_IMAGE_BYTES / 1024 / 1024));
    }
    let bytes = fs::read(source).map_err(|e| format!("读取图片失败 {name}：{e}"))?;
    save_image(base, id, &name, &bytes)
}

/// 读取图片为 data URL，用于显示和发送给模型
pub fn image_data(base: &Path, id: &str, file: &str) -> Result<String, String> {
    check_id(id)?;
    if file.contains(['/', '\\']) || file.contains("..") {
        return Err("无效的图片文件名".into());
    }
    let ext = ext_of(file).ok_or("无效的图片文件名")?;
    let mime = if ext == "jpg" || ext == "jpeg" { "image/jpeg".to_string() } else { format!("image/{ext}") };
    let bytes = fs::read(base.join(id).join(file)).map_err(|e| format!("读取图片失败：{e}"))?;
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_list_read_delete_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("ai-chats");
        assert!(list(&base).unwrap().is_empty());
        write(&base, "a1", r#"{"title":"旧的","updatedAt":1}"#).unwrap();
        write(&base, "b2", r#"{"title":"新的","updatedAt":5}"#).unwrap();
        fs::write(base.join("c3.json"), "{broken").unwrap();
        let items = list(&base).unwrap();
        assert_eq!(items.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(), ["新的", "旧的", "（无法读取的会话）"]);
        assert_eq!(read(&base, "a1").unwrap(), r#"{"title":"旧的","updatedAt":1}"#);

        let file = save_image(&base, "a1", "截图.PNG", &[1, 2, 3]).unwrap();
        assert!(file.ends_with(".png"));
        assert_eq!(image_data(&base, "a1", &file).unwrap(), "data:image/png;base64,AQID");
        delete(&base, "a1").unwrap();
        assert!(!base.join("a1").exists() && !base.join("a1.json").exists());
    }

    #[test]
    fn rejects_bad_ids_names_and_formats() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(write(tmp.path(), "../x", "{}").is_err());
        assert!(write(tmp.path(), "ok", "not json").is_err());
        assert!(save_image(tmp.path(), "ok", "a.bmp", &[1]).is_err());
        assert!(save_image(tmp.path(), "ok", "a.png", &vec![0u8; MAX_IMAGE_BYTES + 1]).is_err());
        assert!(image_data(tmp.path(), "ok", "../secret.png").is_err());
        let file = save_image(tmp.path(), "ok", "a.png", &[1]).unwrap();
        delete_image(tmp.path(), "ok", &file).unwrap();
        assert!(image_data(tmp.path(), "ok", &file).is_err());
        assert!(delete_image(tmp.path(), "ok", "../a.png").is_err());
    }
}
