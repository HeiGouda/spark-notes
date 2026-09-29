//! AI 接口（需求文档 5.16）：OpenAI 兼容的 Chat Completions，流式返回。
//! API Key 只存系统凭据库；接口地址和模型名由前端的应用设置传入。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::secret::{delete_secret, read_secret, write_secret};

const KEY_ACCOUNT: &str = "Spark:ai:apikey";
/// 60 秒内没有收到任何内容算超时
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const RETRY_DELAY: Duration = Duration::from_millis(1500);
pub const TIMEOUT_MESSAGE: &str = "请求超时（60 秒内没有收到任何内容）";

/// content 为字符串，或 OpenAI 兼容的多段内容（文字与 base64 图片）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    /// 服务商给出的上下文长度（tokens），没有给出时为 None
    pub context: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiEvent {
    Delta { text: String },
}

/// 正在进行的请求：id → 取消标记
#[derive(Default)]
pub struct AiState(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl AiState {
    pub fn register(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.0.lock() {
            map.insert(id.to_string(), flag.clone());
        }
        flag
    }

    pub fn finish(&self, id: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(id);
        }
    }

    pub fn cancel(&self, id: &str) {
        if let Ok(map) = self.0.lock() {
            if let Some(flag) = map.get(id) {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }
}

pub fn save_key(key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("API Key 不能为空".into());
    }
    write_secret(KEY_ACCOUNT, key).map_err(|e| e.replace("密码", "API Key"))
}

pub fn has_key() -> Result<bool, String> {
    Ok(read_secret(KEY_ACCOUNT)?.is_some_and(|k| !k.is_empty()))
}

pub fn clear_key() -> Result<(), String> {
    delete_secret(KEY_ACCOUNT)
}

pub fn endpoint(base_url: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("接口地址需以 http:// 或 https:// 开头".into());
    }
    Ok(format!("{base}/chat/completions"))
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(CONNECT_TIMEOUT).timeout_read(READ_TIMEOUT).build()
}

/// 从错误响应里取出服务商给的说明（OpenAI 格式为 {"error":{"message":...}}）
fn error_detail(body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let msg = parsed
        .as_ref()
        .and_then(|v| v["error"]["message"].as_str().or_else(|| v["error"].as_str()).or_else(|| v["message"].as_str()))
        .map(str::to_string)
        .unwrap_or_else(|| body.trim().to_string());
    msg.chars().take(200).collect()
}

pub fn status_message(code: u16, detail: &str) -> String {
    let lower = detail.to_lowercase();
    let head = match code {
        401 | 403 => "认证失败，请检查 API Key".to_string(),
        402 => "余额不足".to_string(),
        404 => "接口地址或模型名不正确".to_string(),
        413 => "超出模型的上下文长度".to_string(),
        429 => "请求太频繁或额度已用完（已自动重试 1 次）".to_string(),
        400 if lower.contains("context") || lower.contains("too long") || (lower.contains("maximum") && lower.contains("token")) => {
            "超出模型的上下文长度".to_string()
        }
        _ => format!("请求失败（HTTP {code}）"),
    };
    if detail.is_empty() { head } else { format!("{head}：{detail}") }
}

fn is_timeout(text: &str) -> bool {
    let t = text.to_lowercase();
    t.contains("timed out") || t.contains("timeout") || t.contains("would block")
}

fn transport_message(err: &ureq::Transport) -> String {
    let text = err.to_string();
    if is_timeout(&text) { TIMEOUT_MESSAGE.to_string() } else { format!("网络错误：{text}") }
}

enum SendError {
    /// 网络错误或限流，可以重试
    Retryable(String),
    Fatal(String),
}

fn send_once(url: &str, key: Option<&str>, body: &Value) -> Result<ureq::Response, SendError> {
    let mut req = agent().post(url).set("Content-Type", "application/json");
    if let Some(k) = key.filter(|k| !k.is_empty()) {
        req = req.set("Authorization", &format!("Bearer {k}"));
    }
    match req.send_string(&body.to_string()) {
        Ok(resp) => Ok(resp),
        Err(ureq::Error::Status(code, resp)) => {
            let msg = status_message(code, &error_detail(&resp.into_string().unwrap_or_default()));
            if code == 429 { Err(SendError::Retryable(msg)) } else { Err(SendError::Fatal(msg)) }
        }
        Err(ureq::Error::Transport(t)) => {
            let msg = transport_message(&t);
            if msg == TIMEOUT_MESSAGE { Err(SendError::Fatal(msg)) } else { Err(SendError::Retryable(msg)) }
        }
    }
}

/// 网络错误、限流自动重试 1 次；其余错误直接返回
fn send(url: &str, key: Option<&str>, body: &Value, cancel: &AtomicBool) -> Result<Option<ureq::Response>, String> {
    match send_once(url, key, body) {
        Ok(r) => Ok(Some(r)),
        Err(SendError::Fatal(m)) => Err(m),
        Err(SendError::Retryable(_)) => {
            std::thread::sleep(RETRY_DELAY);
            if cancel.load(Ordering::SeqCst) {
                return Ok(None);
            }
            match send_once(url, key, body) {
                Ok(r) => Ok(Some(r)),
                Err(SendError::Fatal(m)) | Err(SendError::Retryable(m)) => Err(m),
            }
        }
    }
}

fn load_key() -> Result<Option<String>, String> {
    read_secret(KEY_ACCOUNT)
}

/// 测试连接：发一条很短的请求，返回收到回复所用的毫秒数
pub fn test(base_url: &str, model: &str) -> Result<u64, String> {
    let url = endpoint(base_url)?;
    if model.trim().is_empty() {
        return Err("请填写模型名".into());
    }
    let body = json!({ "model": model.trim(), "messages": [{ "role": "user", "content": "ping" }], "max_tokens": 1, "stream": false });
    let started = Instant::now();
    let never = AtomicBool::new(false);
    let resp = send(&url, load_key()?.as_deref(), &body, &never)?.ok_or("已取消")?;
    let ms = started.elapsed().as_millis() as u64;
    let text = resp.into_string().map_err(|e| if is_timeout(&e.to_string()) { TIMEOUT_MESSAGE.to_string() } else { format!("读取回复失败：{e}") })?;
    let v: Value = serde_json::from_str(&text).map_err(|_| "回复不是 OpenAI 兼容格式，请检查接口地址".to_string())?;
    if v.get("choices").is_none() {
        return Err(format!("回复不是 OpenAI 兼容格式：{}", error_detail(&text)));
    }
    Ok(ms)
}

/// 解析 `GET /models` 的结果；不同服务商用不同的字段名表示上下文长度
pub fn parse_models(body: &str) -> Result<Vec<ProviderModel>, String> {
    let v: Value = serde_json::from_str(body).map_err(|_| format!("模型列表格式无法识别：{}", error_detail(body)))?;
    let items = v["data"].as_array().or_else(|| v.as_array()).ok_or("模型列表格式无法识别")?;
    const KEYS: [&str; 5] = ["context_length", "context_window", "max_context_length", "max_model_len", "max_input_tokens"];
    Ok(items
        .iter()
        .filter_map(|m| {
            let id = m["id"].as_str()?.to_string();
            let context = KEYS
                .iter()
                .find_map(|k| m[*k].as_u64().or_else(|| m["top_provider"][*k].as_u64()))
                .filter(|n| *n > 0);
            Some(ProviderModel { id, context })
        })
        .collect())
}

/// 读取服务商的模型列表（部分服务商会给出上下文长度）
pub fn list_models(base_url: &str) -> Result<Vec<ProviderModel>, String> {
    let base = base_url.trim().trim_end_matches('/');
    endpoint(base)?;
    let mut req = agent().get(&format!("{base}/models"));
    if let Some(k) = load_key()?.filter(|k| !k.is_empty()) {
        req = req.set("Authorization", &format!("Bearer {k}"));
    }
    let resp = req.call().map_err(|e| match e {
        ureq::Error::Status(code, resp) => status_message(code, &error_detail(&resp.into_string().unwrap_or_default())),
        ureq::Error::Transport(t) => transport_message(&t),
    })?;
    let text = resp.into_string().map_err(|e| format!("读取模型列表失败：{e}"))?;
    parse_models(&text)
}

/// SSE 中的一行
#[derive(Debug, PartialEq)]
pub enum SseLine {
    Delta(String),
    Done,
    Error(String),
    Skip,
}

pub fn parse_sse_line(line: &str) -> SseLine {
    let Some(data) = line.trim().strip_prefix("data:") else { return SseLine::Skip };
    let data = data.trim();
    if data == "[DONE]" {
        return SseLine::Done;
    }
    let Ok(v) = serde_json::from_str::<Value>(data) else { return SseLine::Skip };
    if v.get("error").is_some() {
        return SseLine::Error(error_detail(data));
    }
    match v["choices"][0]["delta"]["content"].as_str() {
        Some(t) if !t.is_empty() => SseLine::Delta(t.to_string()),
        _ => SseLine::Skip,
    }
}

/// 流式对话：每收到一段文字调用一次 on_delta；取消后立即返回 Ok
pub fn chat_stream(
    base_url: &str,
    model: &str,
    messages: &[ChatMessage],
    cancel: &AtomicBool,
    mut on_delta: impl FnMut(String) -> Result<(), String>,
) -> Result<(), String> {
    let url = endpoint(base_url)?;
    if model.trim().is_empty() {
        return Err("请填写模型名".into());
    }
    let body = json!({ "model": model.trim(), "messages": messages, "stream": true });
    let Some(resp) = send(&url, load_key()?.as_deref(), &body, cancel)? else { return Ok(()) };
    let streaming = resp.content_type().contains("event-stream");
    if !streaming {
        // 少数服务忽略 stream 参数，直接返回完整结果
        let text = resp.into_string().map_err(|e| format!("读取回复失败：{e}"))?;
        let v: Value = serde_json::from_str(&text).map_err(|_| format!("回复格式无法识别：{}", error_detail(&text)))?;
        let content = v["choices"][0]["message"]["content"].as_str().unwrap_or_default();
        if !content.is_empty() && !cancel.load(Ordering::SeqCst) {
            on_delta(content.to_string())?;
        }
        return Ok(());
    }
    let reader = BufReader::new(resp.into_reader());
    for line in reader.lines() {
        if cancel.load(Ordering::SeqCst) {
            return Ok(());
        }
        let line = line.map_err(|e| if is_timeout(&e.to_string()) { TIMEOUT_MESSAGE.to_string() } else { format!("读取回复失败：{e}") })?;
        match parse_sse_line(&line) {
            SseLine::Delta(t) => on_delta(t)?,
            SseLine::Done => break,
            SseLine::Error(m) => return Err(m),
            SseLine::Skip => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn builds_endpoint() {
        assert_eq!(endpoint("https://api.deepseek.com/v1/").unwrap(), "https://api.deepseek.com/v1/chat/completions");
        assert_eq!(endpoint(" http://localhost:11434/v1 ").unwrap(), "http://localhost:11434/v1/chat/completions");
        assert!(endpoint("api.example.com").is_err());
    }

    #[test]
    fn explains_common_errors() {
        assert!(status_message(401, "").starts_with("认证失败"));
        assert!(status_message(402, "").starts_with("余额不足"));
        assert!(status_message(400, "This model's maximum context length is 8192 tokens").starts_with("超出模型的上下文长度"));
        assert_eq!(status_message(500, "boom"), "请求失败（HTTP 500）：boom");
        assert_eq!(error_detail(r#"{"error":{"message":"Invalid key"}}"#), "Invalid key");
    }

    #[test]
    fn parses_model_lists_from_different_providers() {
        let openrouter = r#"{"data":[{"id":"qwen/qwen-plus","context_length":131072},{"id":"x","top_provider":{"context_length":8192}}]}"#;
        assert_eq!(
            parse_models(openrouter).unwrap(),
            vec![
                ProviderModel { id: "qwen/qwen-plus".into(), context: Some(131072) },
                ProviderModel { id: "x".into(), context: Some(8192) },
            ]
        );
        let plain = r#"{"object":"list","data":[{"id":"deepseek-chat","object":"model"}]}"#;
        assert_eq!(parse_models(plain).unwrap(), vec![ProviderModel { id: "deepseek-chat".into(), context: None }]);
        let vllm = r#"{"data":[{"id":"local","max_model_len":32768}]}"#;
        assert_eq!(parse_models(vllm).unwrap()[0].context, Some(32768));
        assert!(parse_models("<html>").is_err());
    }

    #[test]
    fn sends_image_parts_as_is() {
        let msg = ChatMessage {
            role: "user".into(),
            content: json!([{ "type": "text", "text": "看图" }, { "type": "image_url", "image_url": { "url": "data:image/png;base64,AQID" } }]),
        };
        let body = json!({ "messages": [msg] });
        assert_eq!(body["messages"][0]["content"][1]["image_url"]["url"], "data:image/png;base64,AQID");
    }

    #[test]
    fn parses_stream_lines() {
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"content":"你好"}}]}"#), SseLine::Delta("你好".into()));
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#), SseLine::Skip);
        assert_eq!(parse_sse_line("data: [DONE]"), SseLine::Done);
        assert_eq!(parse_sse_line(": keep-alive"), SseLine::Skip);
        assert_eq!(parse_sse_line(r#"data: {"error":{"message":"quota"}}"#), SseLine::Error("quota".into()));
    }

    /// 读完整个请求（请求头和 Content-Length 指定的正文）再回应，避免客户端还在发送时连接被关闭
    fn read_request(s: &mut std::net::TcpStream) {
        let mut data = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = s.read(&mut buf).unwrap();
            if n == 0 {
                return;
            }
            data.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&data);
            if let Some(end) = text.find("\r\n\r\n") {
                let len = text[..end]
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                    .unwrap_or(0);
                if data.len() >= end + 4 + len {
                    return;
                }
            }
        }
    }

    /// 本机起一个只回应固定内容的 HTTP 服务，依次返回 responses 中的每一项
    fn serve(responses: Vec<String>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for resp in responses {
                let (mut s, _) = listener.accept().unwrap();
                read_request(&mut s);
                s.write_all(resp.as_bytes()).unwrap();
            }
        });
        format!("http://{addr}/v1")
    }

    fn sse_response(chunks: &[&str]) -> String {
        let mut body = String::new();
        for c in chunks {
            body.push_str(&format!("data: {}\n\n", json!({ "choices": [{ "delta": { "content": c } }] })));
        }
        body.push_str("data: [DONE]\n\n");
        format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
    }

    fn json_response(status: &str, body: &str) -> String {
        format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
    }

    #[test]
    fn streams_deltas_and_retries_rate_limit_once() {
        let limited = json_response("429 Too Many Requests", "{}");
        let base = serve(vec![limited, sse_response(&["冲突", "时两份", "都保留"])]);
        let msgs = vec![ChatMessage { role: "user".into(), content: json!("hi") }];
        let mut got = String::new();
        chat_stream(&base, "m", &msgs, &AtomicBool::new(false), |t| {
            got.push_str(&t);
            Ok(())
        })
        .unwrap();
        assert_eq!(got, "冲突时两份都保留");
    }

    #[test]
    fn reports_auth_failure_without_retry() {
        let denied = json_response("401 Unauthorized", r#"{"error":{"message":"Invalid API key"}}"#);
        let base = serve(vec![denied]);
        let err = chat_stream(&base, "m", &[], &AtomicBool::new(false), |_| Ok(())).unwrap_err();
        assert_eq!(err, "认证失败，请检查 API Key：Invalid API key");
    }
}
