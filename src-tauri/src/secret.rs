//! 密码、API Key 等凭据：Windows 存凭据管理器，macOS 存钥匙串

#[cfg(windows)]
pub fn write_secret(account: &str, secret: &str) -> Result<(), String> {
    use windows_sys::Win32::Security::Credentials::{CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC};
    let mut target: Vec<u16> = account.encode_utf16().chain(std::iter::once(0)).collect();
    let mut user: Vec<u16> = "spark".encode_utf16().chain(std::iter::once(0)).collect();
    let mut blob = secret.as_bytes().to_vec();
    let cred = CREDENTIALW {
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        Comment: std::ptr::null_mut(),
        LastWritten: unsafe { std::mem::zeroed() },
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: std::ptr::null_mut(),
        UserName: user.as_mut_ptr(),
    };
    let ok = unsafe { CredWriteW(&cred, 0) };
    if ok == 0 { Err(format!("无法保存密码：{}", std::io::Error::last_os_error())) } else { Ok(()) }
}

#[cfg(windows)]
pub fn read_secret(account: &str) -> Result<Option<String>, String> {
    use windows_sys::Win32::Security::Credentials::{CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC};
    let target: Vec<u16> = account.encode_utf16().chain(std::iter::once(0)).collect();
    let mut ptr: *mut CREDENTIALW = std::ptr::null_mut();
    let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut ptr) };
    if ok == 0 || ptr.is_null() {
        return Ok(None);
    }
    let cred = unsafe { &*ptr };
    let slice = unsafe { std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize) };
    let text = String::from_utf8_lossy(slice).into_owned();
    unsafe { CredFree(ptr as *mut _) };
    Ok(Some(text))
}

/// 删除凭据；本来就没有时也算成功
#[cfg(windows)]
pub fn delete_secret(account: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};
    let target: Vec<u16> = account.encode_utf16().chain(std::iter::once(0)).collect();
    let ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
    if ok == 0 && unsafe { GetLastError() } != ERROR_NOT_FOUND {
        return Err(format!("无法删除凭据：{}", std::io::Error::last_os_error()));
    }
    Ok(())
}

/// 钥匙串里的“服务”名，账号名沿用各处传入的 account
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "Spark";
#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

#[cfg(target_os = "macos")]
pub fn write_secret(account: &str, secret: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, account, secret.as_bytes())
        .map_err(|e| format!("无法保存密码：{e}"))
}

#[cfg(target_os = "macos")]
pub fn read_secret(account: &str) -> Result<Option<String>, String> {
    match security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, account) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        Err(e) => Err(format!("无法读取钥匙串：{e}")),
    }
}

/// 删除凭据；本来就没有时也算成功
#[cfg(target_os = "macos")]
pub fn delete_secret(account: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, account) {
        Err(e) if e.code() != ERR_SEC_ITEM_NOT_FOUND => Err(format!("无法删除凭据：{e}")),
        _ => Ok(()),
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn write_secret(_account: &str, _secret: &str) -> Result<(), String> {
    Err("当前系统不能保存凭据".into())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn read_secret(_account: &str) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn delete_secret(_account: &str) -> Result<(), String> {
    Ok(())
}
