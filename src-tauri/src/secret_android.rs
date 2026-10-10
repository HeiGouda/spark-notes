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

#[derive(Serialize)]
struct UriArg<'a> {
    uri: &'a str,
}

#[derive(Deserialize)]
pub struct CachedFile {
    pub path: String,
}

/// 把系统文件选择器给的 content:// 文件拷到应用缓存目录，返回拷出来的路径
pub fn copy_to_cache(uri: &str) -> Result<CachedFile, String> {
    handle()?.run_mobile_plugin::<CachedFile>("copyToCache", UriArg { uri }).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct Bars {
    light: bool,
}

#[derive(Serialize)]
struct SelectionMenu {
    hidden: bool,
}

/// 状态栏、导航栏图标用深色（`light` 为 true，浅色背景）还是浅色
pub fn set_system_bars(light: bool) -> Result<(), String> {
    handle()?
        .run_mobile_plugin::<serde_json::Value>("setSystemBars", Bars { light })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 阅读页打开时不显示系统的选字工具条
pub fn set_selection_menu(hidden: bool) -> Result<(), String> {
    handle()?
        .run_mobile_plugin::<serde_json::Value>("setSelectionMenu", SelectionMenu { hidden })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageTurnConfig<'a> {
    enabled: bool,
    anim: &'a str,
    can_prev: bool,
    can_next: bool,
    footer: f64,
}

#[derive(Serialize)]
struct PageTurnStart {
    dir: i32,
}

#[derive(Deserialize)]
struct PageTurnStarted {
    started: bool,
}

#[derive(Serialize)]
struct PageTurnReady {
    moved: bool,
}

/// 阅读页翻页动画的设置：能不能滑动翻页、动画种类（slide / cover / fade / none）、两头还能不能翻，
/// footer 是页脚的高度（CSS 像素），翻页截图不盖住它
pub fn page_turn_config(enabled: bool, anim: &str, can_prev: bool, can_next: bool, footer: f64) -> Result<(), String> {
    handle()?
        .run_mobile_plugin::<serde_json::Value>("pageTurnConfig", PageTurnConfig { enabled, anim, can_prev, can_next, footer })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 盖上当前书页的截图；返回 false 表示这次不做动画
pub fn page_turn_start(dir: i32) -> Result<bool, String> {
    handle()?
        .run_mobile_plugin::<PageTurnStarted>("pageTurnStart", PageTurnStart { dir })
        .map(|r| r.started)
        .map_err(|e| e.to_string())
}

/// 书页已经换好，开始翻页动画
pub fn page_turn_ready(moved: bool) -> Result<(), String> {
    handle()?
        .run_mobile_plugin::<serde_json::Value>("pageTurnReady", PageTurnReady { moved })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 书页停稳了：趁空闲先截好前后两页，翻页时直接用
pub fn page_turn_prefetch() -> Result<(), String> {
    handle()?
        .run_mobile_plugin::<serde_json::Value>("pageTurnPrefetch", ())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 离开阅读页时收掉翻页截图
pub fn page_turn_stop() -> Result<(), String> {
    handle()?
        .run_mobile_plugin::<serde_json::Value>("pageTurnStop", ())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 把应用退到后台，回到桌面
pub fn move_to_back() -> Result<(), String> {
    handle()?
        .run_mobile_plugin::<serde_json::Value>("moveToBack", ())
        .map(|_| ())
        .map_err(|e| format!("无法回到桌面：{e}"))
}

/// 当前网络按流量计费（通常是移动数据）
pub fn network_metered() -> Result<bool, String> {
    handle()?
        .run_mobile_plugin::<Metered>("isMetered", ())
        .map(|m| m.metered)
        .map_err(|e| format!("无法获取网络状态：{e}"))
}
