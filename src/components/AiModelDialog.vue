<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { api, type ProviderModel } from "../lib/api";
import { AI_PRESETS, presetOf, sameBaseUrl } from "../lib/ai";
import { formatTokens, newModelId, resolveContext, SOURCE_LABELS, type AiModelEntry } from "../lib/aiModels";
import { credentialStoreName } from "../lib/platform";
import { useSettingsStore } from "../stores/settings";

/** 添加 / 编辑一个 AI 模型（需求文档 5.16）。model 为 null 时是添加 */
const props = defineProps<{ model: AiModelEntry | null }>();
const emit = defineEmits<{ close: [] }>();

const settings = useSettingsStore();
const DEFAULT_PROVIDER = "deepseek";

const provider = ref(props.model?.provider ?? DEFAULT_PROVIDER);
const baseUrl = ref(props.model?.baseUrl ?? presetOf(DEFAULT_PROVIDER).baseUrl);
const name = ref(props.model?.name ?? presetOf(DEFAULT_PROVIDER).models[0]?.name ?? "");
const label = ref(props.model ? props.model.label : (presetOf(DEFAULT_PROVIDER).models[0]?.label ?? ""));
const contextText = ref(props.model?.context ? String(props.model.context) : "");
const providerContext = ref<number | null>(props.model?.providerContext ?? null);

const key = ref("");
const hasKey = ref(false);
const editingKey = ref(false);
const read = ref<ProviderModel[]>([]);
const reading = ref(false);
const testing = ref(false);
const saving = ref(false);
const ok = ref("");
const error = ref("");

const preset = computed(() => presetOf(provider.value));
const urlOk = computed(() => /^https?:\/\/\S+$/.test(baseUrl.value.trim()));

/** 下拉里的模型：预设的，加上从服务商读到的 */
const options = computed(() => {
  const out = preset.value.models.map((m) => ({ name: m.name, hint: m.label }));
  for (const m of read.value) if (!out.some((o) => o.name === m.id)) out.push({ name: m.id, hint: m.context ? formatTokens(m.context) : "" });
  return out;
});

/** 预设模型的显示名称；跟着模型名自动填写，用户改过就不再覆盖 */
function presetLabel(n: string): string {
  return preset.value.models.find((m) => m.name === n)?.label ?? "";
}

function parseTokens(raw: string): number | null {
  const n = Number(raw.replace(/[,，\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

const auto = computed(() => resolveContext({ name: name.value.trim(), context: null, providerContext: providerContext.value }));

function pickProvider(id: string) {
  const prevPreset = preset.value;
  provider.value = id;
  const next = presetOf(id);
  if (next.baseUrl) baseUrl.value = next.baseUrl;
  else if (prevPreset.baseUrl && sameBaseUrl(baseUrl.value, prevPreset.baseUrl)) baseUrl.value = "";
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
  providerContext.value = read.value.find((m) => m.id === n)?.context ?? (n === props.model?.name ? props.model.providerContext : null);
  previousName = n;
}

/** 这个接口地址是否已经保存过 Key（与同一地址的其他模型共用） */
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
    if (seq === keySeq) error.value = `读取 API Key 失败：${messageOf(e)}`;
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
  error.value = "";
  ok.value = "";
  reading.value = true;
  try {
    read.value = await api.aiListModels(baseUrl.value.trim(), key.value.trim() || undefined);
    const withContext = read.value.filter((m) => m.context).length;
    ok.value = `读取到 ${read.value.length} 个模型${withContext ? `，其中 ${withContext} 个给出了上下文长度` : ""}，已加入模型下拉`;
    onNameChange();
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    reading.value = false;
  }
}

async function test() {
  error.value = "";
  ok.value = "";
  testing.value = true;
  try {
    const ms = await api.aiTest(baseUrl.value.trim(), name.value.trim(), key.value.trim() || undefined);
    ok.value = `连接成功，${(ms / 1000).toFixed(1)} 秒内收到回复`;
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    testing.value = false;
  }
}

function validate(): string {
  if (!urlOk.value) return "接口地址需以 http:// 或 https:// 开头";
  if (!name.value.trim()) return "请填写模型名";
  if (contextText.value.trim() && !parseTokens(contextText.value)) return "上下文长度需为正整数";
  const dup = settings.aiModels.find((m) => m.id !== props.model?.id && m.name === name.value.trim() && sameBaseUrl(m.baseUrl, baseUrl.value));
  if (dup) return "这个接口地址下已经添加过这个模型";
  return "";
}

async function save() {
  error.value = validate();
  if (error.value) return;
  saving.value = true;
  const url = baseUrl.value.trim().replace(/\/+$/, "");
  try {
    if (key.value.trim()) await api.aiSaveKey(url, key.value);
    const entry: AiModelEntry = {
      id: props.model?.id ?? newModelId(),
      provider: provider.value,
      baseUrl: url,
      name: name.value.trim(),
      label: label.value.trim(),
      context: parseTokens(contextText.value),
      providerContext: providerContext.value,
    };
    const old = props.model;
    settings.upsertAiModel(entry);
    // 改了接口地址：原地址已没有模型使用时，一并清除它的 Key
    if (old && !sameBaseUrl(old.baseUrl, url) && !settings.aiModels.some((m) => sameBaseUrl(m.baseUrl, old.baseUrl))) {
      await api.aiClearKey(old.baseUrl);
    }
    emit("close");
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    saving.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  emit("close");
}

onMounted(() => window.addEventListener("keydown", onKey, true));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <div class="mask" @mousedown.self="emit('close')">
    <form class="pop ai-dlg aim-dlg" role="dialog" :aria-label="model ? '编辑模型' : '添加模型'" @submit.prevent="save()">
      <div class="keys-head">
        <h3>{{ model ? "编辑模型" : "添加模型" }}</h3>
        <button class="btn" type="button" title="关闭 (Esc)" @click="emit('close')"><Icon name="close" sm /></button>
      </div>
      <div class="git-body aim-body">
        <label for="aim-provider">服务商</label>
        <select id="aim-provider" class="set-select" :value="provider" @change="pickProvider(($event.target as HTMLSelectElement).value)">
          <option v-for="p in AI_PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
        <p v-if="preset.hint" class="git-hint">{{ preset.hint }}</p>

        <label for="aim-url">接口地址</label>
        <input id="aim-url" v-model.trim="baseUrl" type="text" spellcheck="false" placeholder="https://…/v1" />

        <label for="aim-key">API Key</label>
        <div v-if="hasKey && !editingKey" class="api-key-row">
          <Icon name="key" sm /><span class="flex">已保存到{{ credentialStoreName }}（与同一接口地址的其他模型共用）</span>
          <button class="scm-link" type="button" @click="editingKey = true">修改</button>
        </div>
        <div v-else class="key-edit">
          <input id="aim-key" v-model="key" type="password" autocomplete="off" :placeholder="preset.local ? '本机服务可以不填' : hasKey ? '留空则不修改' : '只保存在这台电脑的系统凭据库里'" />
          <button v-if="hasKey" class="fb-txt" type="button" @click="(editingKey = false), (key = '')">取消</button>
        </div>

        <label for="aim-name">模型</label>
        <div class="aim-name">
          <input id="aim-name" v-model="name" type="text" spellcheck="false" list="aim-options" placeholder="从下拉选择，或直接输入模型名" @change="onNameChange()" />
          <datalist id="aim-options">
            <option v-for="o in options" :key="o.name" :value="o.name">{{ o.hint }}</option>
          </datalist>
          <button class="fb-txt" type="button" :disabled="reading || !urlOk" title="调用服务商的模型列表接口，读到的模型加入下拉" @click="readModels()">{{ reading ? "正在读取…" : "从服务商读取" }}</button>
        </div>

        <label for="aim-label">显示名称（可选）</label>
        <input id="aim-label" v-model="label" type="text" spellcheck="false" :placeholder="name.trim() || '不填时显示模型名'" />

        <label for="aim-ctx">上下文长度（可选）</label>
        <input id="aim-ctx" v-model="contextText" class="aim-ctx" type="text" inputmode="numeric" :placeholder="`自动：${formatTokens(auto.tokens)}（${SOURCE_LABELS[auto.source]}）`" />

        <p v-if="error" class="git-error">{{ error }}</p>
        <p v-else-if="ok" class="test-ok"><Icon name="check" sm />{{ ok }}</p>
      </div>
      <div class="ai-dlg-actions">
        <button class="fb-txt" type="button" :disabled="testing || !urlOk || !name.trim()" @click="test()">{{ testing ? "正在测试…" : "测试连接" }}</button>
        <span class="flex" />
        <button class="fb-txt" type="button" @click="emit('close')">取消</button>
        <button class="btn-primary" type="submit" :disabled="saving">保存</button>
      </div>
    </form>
  </div>
</template>
