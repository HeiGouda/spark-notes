/** 把纯文本放进剪贴板。原生书页上的点击没有网页手势，要先走系统桥。 */

type CopyResult = { ok: true } | { ok: false; reason: string };

type CopyBridge = { copyText?: (value: string) => boolean };

export async function copyPlainText(text: string): Promise<CopyResult> {
  if (!text) return { ok: false, reason: "没有可复制的文字" };
  const bridge = (window as unknown as { NativePages?: CopyBridge }).NativePages;
  try {
    if (bridge?.copyText?.(text)) return { ok: true };
  } catch {
    /* 桥不可用时再试网页 */
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    }
  } catch {
    /* 没有手势或焦点时浏览器会拒绝。英文异常不拿去提示 */
  }
  if (copyByCommand(text)) return { ok: true };
  return { ok: false, reason: "系统没有允许写入剪贴板" };
}

/** 桌面或旧网页没有桥、也没有剪贴板权限时的最后一步 */
function copyByCommand(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(area);
  area.focus();
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
