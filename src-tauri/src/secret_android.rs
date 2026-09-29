//! 安卓的凭据交给 `SecretPlugin.kt`：用 AndroidKeyStore 加密后存在应用私有存储。
//! 调用会阻塞到 Kotlin 返回，只能在后台线程里用，不能在界面线程（同步命令）里调。

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::Wry;

static HANDLE: OnceLock<PluginHandle<Wry>> = OnceLock::new();

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("spark-secret")
        .setup(|_app, api| {
            let handle = api.register_android_plugin("com.spark.app", "SecretPlugin")?;
            let _ = HANDLE.set(handle);
            Ok(())
        })
        .build()
}

fn handle() -> Result<&'static PluginHandle<Wry>, String> {
    HANDLE.get().ok_or_else(|| "凭据存储尚未就绪".into())
}

#[derive(Serialize)]
struct Account<'a> {
    account: &'a str,
}

#[derive(Serialize)]
struct Write<'a> {
    account: &'a str,
    secret: &'a str,
}

#[derive(Deserialize)]
struct Read {
    secret: Option<String>,
}

#[derive(Deserialize)]
struct Metered {
    metered: bool,
}

pub fn write_secret(account: &str, secret: &str) -> Result<(), String> {
    handle()?
        .run_mobile_plugin::<serde_json::Value>("write", Write { account, secret })
        .map(|_| ())
        .map_err(|e| format!("无法保存密码：{e}"))
}

pub fn read_secret(account: &str) -> Result<Option<String>, String> {
    handle()?
        .run_mobile_plugin::<Read>("read", Account { account })
        .map(|r| r.secret)
        .map_err(|e| format!("无法读取密码：{e}"))
}

/// 删除凭据；本来就没有时也算成功
pub fn delete_secret(account: &str) -> Result<(), String> {
    handle()?
        .run_mobile_plugin::<serde_json::Value>("remove", Account { account })
        .map(|_| ())
        .map_err(|e| format!("无法删除凭据：{e}"))
}

/// 当前网络按流量计费（通常是移动数据）
pub fn network_metered() -> Result<bool, String> {
    handle()?
        .run_mobile_plugin::<Metered>("isMetered", ())
        .map(|m| m.metered)
        .map_err(|e| format!("无法获取网络状态：{e}"))
}
