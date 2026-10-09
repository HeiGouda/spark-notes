import { ref } from "vue";
import { addBackInterceptor } from "./nav";

/** 应用内的确认框。系统自带的 confirm() 在安卓上标题是网址、按钮是英文，不用它 */
export interface AskOptions {
  title: string;
  message?: string;
  ok?: string;
  cancel?: string;
  /** 确认按钮用红色（删除这类不能撤销的操作） */
  danger?: boolean;
  /** 带一个勾选项，例如“同时删除云端文件” */
  check?: string;
  checked?: boolean;
}

interface Pending extends AskOptions {
  checked: boolean;
  resolve: (ok: boolean) => void;
}

export const asking = ref<Pending | null>(null);

export function ask(options: AskOptions): Promise<boolean> {
  return askWithCheck(options).then((r) => r.ok);
}

/** 带勾选项的确认框：返回是否确认、确认时勾选项的状态 */
export function askWithCheck(options: AskOptions): Promise<{ ok: boolean; checked: boolean }> {
  asking.value?.resolve(false);
  return new Promise((resolve) => {
    const pending: Pending = {
      ...options,
      checked: options.checked ?? false,
      resolve: (ok) => resolve({ ok, checked: ok && pending.checked }),
    };
    asking.value = pending;
  });
}

/** 关掉确认框；返回键、点遮罩都算取消 */
export function answer(ok: boolean) {
  const current = asking.value;
  if (!current) return;
  asking.value = null;
  current.resolve(ok);
}

addBackInterceptor(() => {
  if (!asking.value) return false;
  answer(false);
  return true;
});
