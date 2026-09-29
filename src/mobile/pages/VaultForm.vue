<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import Icon from "../Icon.vue";
import { mobileApi, type VaultInput } from "../api";
import { useMobile } from "../store";
import { back, reset, toast } from "../nav";

const props = defineProps<{ id: string | null }>();
const store = useMobile();
const editing = computed(() => (props.id ? store.vaults.find((v) => v.id === props.id) ?? null : null));

const form = reactive({
  name: editing.value?.name ?? "",
  url: editing.value?.url ?? "",
  username: editing.value?.username ?? "",
  remoteDir: editing.value?.remoteDir ?? "/",
  password: "",
});
const showPw = ref(false);
const busy = ref(false);
const result = ref<{ ok: boolean; text: string } | null>(null);
const urlInput = ref<HTMLInputElement | null>(null);

const PRESETS: [string, string][] = [
  ["坚果云", "https://dav.jianguoyun.com/dav/"],
  ["Nextcloud", "https://域名/remote.php/dav/files/用户名/"],
  ["自建（Spark 部署脚本）", "https://域名/dav"],
];

function preset(url: string) {
  form.url = url;
  urlInput.value?.focus();
}

function input(): VaultInput {
  const remoteDir = form.remoteDir.trim() || "/";
  const name = form.name.trim() || remoteDir.split("/").filter(Boolean).pop() || "新笔记库";
  return { name, url: form.url.trim(), remoteDir, username: form.username.trim() };
}

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

function ready(): boolean {
  if (form.url.trim()) return true;
  result.value = { ok: false, text: "请填写 WebDAV 地址" };
  return false;
}

async function test() {
  if (!ready()) return;
  busy.value = true;
  result.value = { ok: true, text: "正在连接…" };
  try {
    const info = await mobileApi.testVault(props.id, input(), form.password);
    result.value = { ok: true, text: `连接成功，云端目录里有 ${info.files} 个文件` };
  } catch (e) {
    result.value = { ok: false, text: `连接失败：${message(e)}` };
  } finally {
    busy.value = false;
  }
}

async function save() {
  if (!ready()) return;
  busy.value = true;
  result.value = { ok: true, text: "正在连接并保存…" };
  try {
    if (props.id) {
      await store.updateVault(props.id, input(), form.password);
      back();
      toast("已保存");
    } else {
      const v = await store.addVault(input(), form.password);
      reset({ p: "files", path: "" }, { p: "firstsync", id: v.id });
    }
  } catch (e) {
    result.value = { ok: false, text: message(e) };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page bare">
    <div class="top">
      <button class="ib" @click="back()"><Icon name="back" /></button>
      <h1>{{ id ? "编辑笔记库" : "添加笔记库" }}</h1>
    </div>
    <div class="scroll">
      <div class="form">
        <div class="field">
          <label for="f-name">名称</label>
          <div class="inp"><input id="f-name" v-model="form.name" placeholder="例如：工作笔记" /></div>
        </div>
        <div class="field">
          <label for="f-url">WebDAV 地址</label>
          <div class="inp">
            <input id="f-url" ref="urlInput" v-model="form.url" type="url" placeholder="https://" autocapitalize="off" />
          </div>
          <div class="chips">
            <button v-for="[label, url] in PRESETS" :key="label" class="chip" @click="preset(url)">{{ label }}</button>
          </div>
        </div>
        <div class="field">
          <label for="f-user">用户名</label>
          <div class="inp"><input id="f-user" v-model="form.username" placeholder="账号或邮箱" autocapitalize="off" /></div>
        </div>
        <div class="field">
          <label for="f-pw">密码</label>
          <div class="inp">
            <input
              id="f-pw"
              v-model="form.password"
              :type="showPw ? 'text' : 'password'"
              :placeholder="id ? '已保存，不修改可留空' : '坚果云请填“应用密码”'"
              autocomplete="off"
            />
            <button class="ib" title="显示密码" @click="showPw = !showPw"><Icon name="eye" :size="18" /></button>
          </div>
        </div>
        <div class="field">
          <label for="f-dir">远端目录</label>
          <div class="inp"><input id="f-dir" v-model="form.remoteDir" placeholder="/spark/工作笔记" autocapitalize="off" /></div>
          <p class="hint">笔记库在云端所在的文件夹，要和电脑上设置的一致</p>
        </div>
        <div class="test">
          <button class="btn" :disabled="busy" @click="test">测试连接</button>
          <span class="res" :class="result && (result.ok ? (result.text.startsWith('连接成功') ? 'ok' : '') : 'bad')">{{ result?.text }}</span>
        </div>
        <button class="btn pri block" :disabled="busy" @click="save">{{ id ? "保存" : "保存并开始同步" }}</button>
        <p class="hint" style="margin-top: 12px; display: flex; gap: 6px">
          <Icon name="lock" :size="14" />密码只保存在本机，由安卓系统密钥库加密，不写入任何文件。
        </p>
      </div>
    </div>
  </div>
</template>
