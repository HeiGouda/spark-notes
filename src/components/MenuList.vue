<script setup lang="ts">
import { computed, ref } from "vue";
import Icon from "./Icon.vue";
import { isEnabled, runCommand, shortcutOf } from "../lib/commands";
import { displayShortcut } from "../lib/shortcut";
import { useNoticeStore } from "../stores/notice";

export type MenuEntry =
  | {
      kind: "item";
      label: string;
      /** 应用命令 id；与 action 二选一，都没有表示尚未实现 */
      command?: string;
      action?: () => unknown;
      disabled?: boolean;
      hint?: string;
      checked?: () => boolean;
    }
  | { kind: "sep" }
  | { kind: "sub"; label: string; items: MenuEntry[] };

const props = defineProps<{ items: MenuEntry[]; sub?: boolean; at?: { x: number; y: number } }>();
const emit = defineEmits<{ done: [] }>();
const openSub = ref<number | null>(null);

const style = computed(() => {
  if (!props.at) return undefined;
  const x = Math.min(props.at.x, window.innerWidth - 220);
  const y = Math.min(props.at.y, window.innerHeight - 40 - props.items.length * 28);
  return { position: "fixed" as const, left: `${Math.max(x, 4)}px`, top: `${Math.max(y, 4)}px` };
});

function hintOf(entry: Extract<MenuEntry, { kind: "item" }>): string {
  if (entry.hint) return entry.hint;
  return displayShortcut(entry.command ? shortcutOf(entry.command) : null);
}

function disabledOf(entry: Extract<MenuEntry, { kind: "item" }>): boolean {
  if (entry.disabled) return true;
  if (entry.command) return !isEnabled(entry.command);
  return !entry.action;
}

async function run(entry: Extract<MenuEntry, { kind: "item" }>) {
  emit("done");
  try {
    if (entry.command) await runCommand(entry.command);
    else await entry.action?.();
  } catch (e) {
    useNoticeStore().report(`执行“${entry.label}”失败`, e);
  }
}
</script>

<template>
  <div class="menu" :class="sub ? 'menu-sub' : at ? '' : 'menu-root'" :style="style" role="menu" @contextmenu.prevent>
    <template v-for="(entry, i) in items" :key="i">
      <div v-if="entry.kind === 'sep'" class="menu-sep" />
      <button
        v-else-if="entry.kind === 'item'"
        class="menu-item"
        role="menuitem"
        :disabled="disabledOf(entry)"
        :title="entry.command || entry.action ? undefined : '尚未实现，将在后续里程碑提供'"
        @mousedown.prevent
        @mouseenter="openSub = null"
        @click="run(entry)"
      >
        <span class="mark"><Icon v-if="entry.checked?.()" name="check" sm /></span>
        <span class="label">{{ entry.label }}</span>
        <span class="hint">{{ hintOf(entry) }}</span>
      </button>
      <div v-else class="menu-item" :class="{ 'is-open': openSub === i }" role="menuitem" @mouseenter="openSub = i">
        <span class="mark" />
        <span class="label">{{ entry.label }}</span>
        <Icon name="right" sm />
        <MenuList v-if="openSub === i" :items="entry.items" sub @done="emit('done')" />
      </div>
    </template>
  </div>
</template>
