<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Icon from "../Icon.vue";
import { api, type ProviderModel } from "../../lib/api";
import { AI_PRESETS, presetOf, sameBaseUrl } from "../../lib/ai";
import { formatTokens, newModelId, resolveContext, SOURCE_LABELS, type AiModelEntry } from "../../lib/aiModels";
import { useMobileAi } from "../ai";
import { back, toast } from "../nav";
import { ask } from "../dialog";

const props = defineProps<{ id: string | null }>();
const ai = useMobileAi();
const editing = computed(() => (props.id ? ai.models.find((m) => m.id === props.id) ?? null : null));

const DEFAULT_PROVIDER = "deepseek";
const provider = ref(editing.value?.provider ?? DEFAULT_PROVIDER);
const baseUrl = ref(editing.value?.baseUrl ?? presetOf(DEFAULT_PROVIDER).baseUrl);
const name = ref(editing.value?.name ?? presetOf(DEFAULT_PROVIDER).models[0]?.name ?? "");
const label = ref(editing.value ? editing.value.label : (presetOf(DEFAULT_PROVIDER).models[0]?.label ?? ""));
const contextText = ref(editing.value?.context ? String(editing.value.context) : "");
const providerContext = ref<number | null>(editing.value?.providerContext ?? null);

const key = ref("");
const hasKey = ref(false);
const editingKey = ref(false);
const read = ref<ProviderModel[]>([]);
const busy = ref("");
const result = ref<{ ok: boolean; text: string } | null>(null);

const preset = computed(() => presetOf(provider.value));
const urlOk = computed(() => /^https?:\/\/\S+$/.test(baseUrl.value.trim()));

function presetLabel(n: string): string {
  return preset.value.models.find((m) => m.name === n)?.label ?? "";
}

function parseTokens(raw: string): number | null {
  const n = Number(raw.replace(/[,，\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

const auto = computed(() => resolveContext({ name: name.value.trim(), context: null, providerContext: providerContext.value }));

function pickProvider(id: string) {
  const prev = preset.value;
  provider.value = id;
  const next = presetOf(id);
  if (next.baseUrl) baseUrl.value = next.baseUrl;
  else if (prev.baseUrl && sameBaseUrl(baseUrl.value, prev.baseUrl)) baseUrl.value = "";
  read.value = [];
  name.value = next.models[0]?.name ?? "";
  label.value = next.models[0]?.label ?? "";
  previousName = name.value;
  providerContext.value = null;
}

let previousName = name.value;
function onNameChange() {
  const n = name.value.trim();
  if (!label.value.trim() || label.value === presetLabel(previousName)) label.value = presetLabel(n);
  providerContext.value = read.value.find((m) => m.id === n)?.context ?? (n === editing.value?.name ? (editing.value?.providerContext ?? null) : null);
  previousName = n;
}

let keySeq = 0;
async function refreshKey() {
  const seq = ++keySeq;
  const url = baseUrl.value.trim();
  if (!urlOk.value) {
    hasKey.value = false;
    return;
  }
  try {
    const has = await api.aiHasKey(url);
    if (seq === keySeq) hasKey.value = has;
  } catch (e) {
    if (seq === keySeq) result.value = { ok: false, text: `读取 API Key 失败：${messageOf(e)}` };
  }
}
watch(baseUrl, () => {
  editingKey.value = false;
  void refreshKey();
}, { immediate: true });

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function readModels() {
  result.value = null;
  busy.value = "read";
  try {
    read.value = await api.aiListModels(baseUrl.value.trim(), key.value.trim() || undefined);
    const withContext = read.value.filter((m) => m.context).length;
    result.value = { ok: true, text: `读取到 ${read.value.length} 个模型${withContext ? `，其中 ${withContext} 个给出了上下文长度` : ""}` };
    onNameChange();
  } catch (e) {
    result.value = { ok: false, text: messageOf(e) };
  } finally {
    busy.value = "";
  }
}

async function test() {
  result.value = null;
  busy.value = "test";
  try {
    const ms = await api.aiTest(baseUrl.value.trim(), name.value.trim(), key.value.trim() || undefined);
    result.value = { ok: true, text: `连接成功，${(ms / 1000).toFixed(1)} 秒内收到回复` };
  } catch (e) {
    result.value = { ok: false, text: messageOf(e) };
  } finally {
    busy.value = "";
  }
}

function validate(): string {
  if (!urlOk.value) return "接口地址需以 http:// 或 https:// 开头";
  if (!name.value.trim()) return "请填写模型名";
  if (contextText.value.trim() && !parseTokens(contextText.value)) return "上下文长度需为正整数";
  const dup = ai.models.find((m) => m.id !== editing.value?.id && m.name === name.value.trim() && sameBaseUrl(m.baseUrl, baseUrl.value));
  if (dup) return "这个接口地址下已经添加过这个模型";
  return "";
}

async function save() {
  const problem = validate();
  if (problem) {
    result.value = { ok: false, text: problem };
    return;
  }
  busy.value = "save";
  const url = baseUrl.value.trim().replace(/\/+$/, "");
  try {
    if (key.value.trim()) await api.aiSaveKey(url, key.value);
    const entry: AiModelEntry = {
      id: editing.value?.id ?? newModelId(),
      provider: provider.value,
      baseUrl: url,
      name: name.value.trim(),
      label: label.value.trim(),
      context: parseTokens(contextText.value),
      providerContext: providerContext.value,
    };
    const old = editing.value;
    ai.upsert(entry);
    if (old && !sameBaseUrl(old.baseUrl, url) && !ai.models.some((m) => sameBaseUrl(m.baseUrl, old.baseUrl))) {
      await api.aiClearKey(old.baseUrl);
    }
    back();
    toast(old ? "已保存" : "已添加模型");
  } catch (e) {
    result.value = { ok: false, text: messageOf(e) };
  } finally {
    busy.value = "";
  }
}

async function removeModel() {
  const m = editing.value;
  if (!m || !(await ask({ title: `删除模型“${m.label.trim() || m.name}”？`, message: "用这个模型的对话会改用默认模型。", ok: "删除", danger: true }))) return;
  busy.value = "del";
  try {
    ai.remove(m.id);
    if (!ai.models.some((x) => sameBaseUrl(x.baseUrl, m.baseUrl))) await api.aiClearKey(m.baseUrl);
    back();
    toast("已删除模型");
  } catch (e) {
    result.value = { ok: false, text: messageOf(e) };
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <div class="page bare">
    <div class="top">
      <button class="ib" @click="back()"><Icon name="back" /></button>
      <h1>{{ editing ? "编辑模型" : "添加模型" }}</h1>
      <button class="btn sm pri" :disabled="!!busy" @click="save">保存</button>
    </div>
    <div class="scroll gray">
      <div class="grp-t">服务</div>
      <div class="grp">
        <div class="row">
          <span class="main"><div class="name">服务商</div></span>
          <span class="v">
            <select class="plain" :value="provider" @change="pickProvider(($event.target as HTMLSelectElement).value)">
              <option v-for="p in AI_PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
          </span>
        </div>
        <div class="fld"><label>接口地址</label><div class="box"><input v-model.trim="baseUrl" type="url" placeholder="https://…/v1" autocapitalize="off" spellcheck="false" /></div></div>
        <div class="fld">
          <label>API Key</label>
          <template v-if="hasKey && !editingKey">
            <div class="box muted">已保存（与同一接口地址的其他模型共用）</div>
            <button class="linkish" @click="editingKey = true">修改</button>
          </template>
          <div v-else class="box"><input v-model="key" type="password" autocomplete="off" :placeholder="preset.local ? '本机服务可以不填' : hasKey ? '留空则不修改' : '只保存在这台手机的系统密钥库里'" /></div>
        </div>
      </div>
      <p v-if="preset.hint" class="ghint">{{ preset.hint }}</p>

      <div class="grp-t">模型</div>
      <div class="grp">
        <div class="fld">
          <label>模型 <button class="linkish" :disabled="!!busy || !urlOk" @click="readModels">{{ busy === "read" ? "正在读取…" : "从服务商读取" }}</button></label>
          <div class="box"><input v-model="name" list="m-models" placeholder="从下拉选择，或直接输入模型名" autocapitalize="off" spellcheck="false" @change="onNameChange" /></div>
          <datalist id="m-models">
            <option v-for="o in preset.models" :key="o.name" :value="o.name">{{ o.label }}</option>
            <option v-for="m in read" :key="m.id" :value="m.id">{{ m.context ? formatTokens(m.context) : "" }}</option>
          </datalist>
        </div>
        <div class="fld"><label>显示名称（可选）</label><div class="box"><input v-model="label" :placeholder="name.trim() || '不填时显示模型名'" /></div></div>
        <div class="fld"><label>上下文长度（可选）</label><div class="box"><input v-model="contextText" inputmode="numeric" :placeholder="`自动：${formatTokens(auto.tokens)}（${SOURCE_LABELS[auto.source]}）`" /></div></div>
      </div>

      <div class="flex" style="padding: 12px 16px; gap: 10px">
        <button class="btn sm" :disabled="!!busy || !urlOk || !name.trim()" @click="test">{{ busy === "test" ? "正在测试…" : "测试连接" }}</button>
        <span class="res" :class="result && (result.ok ? 'ok' : 'bad')">{{ result?.text }}</span>
      </div>
      <button v-if="editing" class="btn text block" style="color: var(--danger)" :disabled="!!busy" @click="removeModel">删除这个模型</button>
    </div>
  </div>
</template>
