export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** 系统文件管理器的名称，用于“在资源管理器中打开”一类的菜单 */
export const fileManagerName = isMac ? "访达" : "资源管理器";

/** 保存密码、API Key 的系统凭据库名称 */
export const credentialStoreName = isMac ? "钥匙串" : "Windows 凭据管理器";
