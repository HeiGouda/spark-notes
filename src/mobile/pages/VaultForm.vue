<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import Icon from "../Icon.vue";
import { mobileApi, type VaultInput } from "../api";
import { useMobile } from "../store";
import { back, open, reset, toast } from "../nav";

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

/* 添加时：填好地址、账号、密码后连上服务器，从云端 spark/ 里已有的笔记库里选一个 */
const adding = computed(() => !props.id);
const libs = ref<string[] | null>(null);
const picked = ref("");
/** 笔记库不在 spark/ 下时，手动填名称和远端目录 */
const manual = ref(false);
const showFields = computed(() => !adding.value || manual.value);
watch(
  () => [form.url, form.username, form.password],
  () => {
    libs.value = null;
    picked.value = "";
  },
);

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

async function connect() {
  if (!ready()) return;
  busy.value = true;
  result.value = { ok: true, text: "正在连接…" };
  try {
    const found = await mobileApi.vaultLibraries(form.url.trim(), form.username.trim(), form.password);
    libs.value = found;
    picked.value = found.length === 1 ? found[0] : "";
    result.value = found.length ? null : { ok: false, text: "云端的 spark 文件夹里还没有笔记库。先在电脑上把笔记库上传一次，再回来选择。" };
  } catch (e) {
    libs.value = null;
    result.value = { ok: false, text: `连接失败：${message(e)}` };
  } finally {
    busy.value = false;
  }
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
  if (adding.value && !manual.value && !picked.value) {
    result.value = { ok: false, text: "先点“连接”，再选一个笔记库" };
    return;
  }
  busy.value = true;
  result.value = { ok: true, text: "正在连接并保存…" };
  try {
    if (props.id) {
      await store.updateVault(props.id, input(), form.password);
      back();
      toast("已保存");
    } else {
      const chosen: VaultInput = {
        name: picked.value,
        url: form.url.trim(),
        username: form.username.trim(),
        remoteDir: `spark/${picked.value}`,
      };
      const v = await store.addVault(manual.value ? input() : chosen, form.password);
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
        <div v-if="showFields" class="field">
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
        <div v-if="adding && !manual" class="test">
          <button class="btn" :disabled="busy" @click="connect">{{ libs ? "重新连接" : "连接" }}</button>
          <span class="res" :class="result && !result.ok ? 'bad' : ''">{{ result?.text }}</span>
        </div>
        <template v-if="adding && !manual && libs?.length">
          <label class="seglabel" style="padding-left: 0">选择笔记库</label>
          <div class="grp" style="margin: 0 0 14px">
            <button v-for="name in libs" :key="name" class="row" @click="picked = name">
              <span class="main">
                <div class="name">{{ name }}</div>
                <div class="sub">spark/{{ name }}</div>
              </span>
              <Icon v-if="picked === name" name="check" :size="18" />
            </button>
          </div>
        </template>
        <div v-if="showFields" class="field">
          <label for="f-dir">远端目录</label>
          <div class="inp"><input id="f-dir" v-model="form.remoteDir" placeholder="/spark/工作笔记" autocapitalize="off" /></div>
          <p class="hint">笔记库在云端所在的文件夹，要和电脑上设置的一致</p>
        </div>
        <div v-if="showFields" class="test">
          <button class="btn" :disabled="busy" @click="test">测试连接</button>
          <span class="res" :class="result && (result.ok ? (result.text.startsWith('连接成功') ? 'ok' : '') : 'bad')">{{ result?.text }}</span>
        </div>
        <button
          v-if="!adding || manual || libs?.length"
          class="btn pri block"
          :disabled="busy || (adding && !manual && !picked)"
          @click="save"
        >
          {{ id ? "保存" : "保存并开始同步" }}
        </button>
        <button v-if="adding" class="btn text block" style="margin-top: 6px" :disabled="busy" @click="manual = !manual; result = null">
          {{ manual ? "改成从云端选择笔记库" : "笔记库不在 spark/ 下？手动填写目录" }}
        </button>
        <button v-if="id" class="btn text block" style="margin-top: 6px; color: var(--danger)" :disabled="busy" @click="open({ t: 'del', id })">
          删除这个笔记库
        </button>
        <p class="hint" style="margin-top: 12px; display: flex; gap: 6px">
          <Icon name="lock" :size="14" />密码只保存在本机，由安卓系统密钥库加密，不写入任何文件。
        </p>
      </div>
    </div>
  </div>
</template>
