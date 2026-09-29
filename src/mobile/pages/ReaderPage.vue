<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type Backlink, type TreeNode } from "../../lib/api";
import Icon from "../Icon.vue";
import ReaderSettings from "../ReaderSettings.vue";
import ImageViewer from "../reader/ImageViewer.vue";
import { renderNote, type Rendered } from "../reader/render";
import { folderLabel, timeLabel } from "../browse";
import { useMobile } from "../store";
import { back, close, currentOverlay, open, openDoc, toast } from "../nav";

const props = defineProps<{ path: string; heading?: string }>();
const store = useMobile();
const doc = ref<Rendered | null>(null);
const error = ref("");
const backlinks = ref<Backlink[]>([]);
const title = props.path.slice(props.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

function allNotes(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const n of nodes) {
    if (n.isDir) allNotes(n.children, out);
    else out.push(n);
  }
  return out;
}

const notes = computed(() => allNotes(store.tree));
const modified = computed(() => notes.value.find((n) => n.path === props.path)?.modifiedMs ?? null);

function scrollToHeading(name: string) {
  const want = name.trim().toLowerCase();
  const h = doc.value?.headings.find((x) => x.text.toLowerCase() === want);
  if (h) document.getElementById(h.id)?.scrollIntoView({ block: "start" });
  else toast(`找不到标题“${name}”`);
}

onMounted(async () => {
  void store.rememberOpen(props.path);
  const root = store.root;
  if (!root) return;
  try {
    const { content } = await api.readNote(root, props.path);
    doc.value = renderNote(content, {
      path: props.path,
      notes: notes.value.map((n) => n.path),
      resolveAsset: (rel) => convertFileSrc(`${root}/${rel}`),
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    return;
  }
  if (props.heading) {
    await nextTick();
    scrollToHeading(props.heading);
  }
  backlinks.value = await api.backlinks(root, props.path).catch(() => []);
});

function onClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const img = target.closest("img");
  if (img) {
    open({ t: "image", src: img.src, alt: img.alt });
    return;
  }
  const a = target.closest("a");
  if (!a) return;
  e.preventDefault();
  const note = a.dataset.note;
  if (note) {
    if (note === props.path) {
      if (a.dataset.heading) scrollToHeading(a.dataset.heading);
    } else {
      openDoc(note, a.dataset.heading);
    }
  } else if (a.dataset.missing !== undefined) {
    toast(`笔记“${a.dataset.missing}”不存在`);
  } else if (a.dataset.external) {
    openUrl(a.dataset.external).catch((err) => toast(`打不开链接：${err}`));
  } else {
    toast("找不到链接指向的文件");
  }
}

function jump(id: string) {
  close();
  document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
}
</script>

<template>
  <div class="page bare">
    <div class="top">
      <button class="ib" @click="back()"><Icon name="back" /></button>
      <h1>{{ title }}</h1>
      <button class="ib" title="大纲" :disabled="!doc?.headings.length" @click="open({ t: 'outline' })"><Icon name="outline" /></button>
      <button class="ib" title="阅读设置" @click="open({ t: 'readset' })"><Icon name="aa" /></button>
    </div>
    <div class="scroll">
      <div v-if="error" class="m-empty">{{ error }}</div>
      <article v-else-if="doc" class="read">
        <div class="read-meta">
          <span>{{ folderLabel(path) }}<template v-if="modified"> · {{ timeLabel(modified) }}</template></span>
          <span v-for="t in doc.tags" :key="t" class="tag">#{{ t }}</span>
        </div>
        <div class="read-body" @click="onClick" v-html="doc.html"></div>
        <section class="backlinks">
          <h3>反向链接（{{ backlinks.length }}）</h3>
          <button v-for="b in backlinks" :key="b.path" @click="openDoc(b.path)">
            <b>{{ b.title }}</b><span>{{ b.line }}</span>
          </button>
          <p v-if="!backlinks.length" class="none">没有笔记链接到这里</p>
        </section>
      </article>
    </div>
    <template v-if="currentOverlay?.t === 'outline' && doc">
      <div class="m-ovl">
        <div class="mask" @click="close()"></div>
        <div class="sheet">
          <div class="grab"></div>
          <h2>大纲</h2>
          <div class="ol">
            <button v-for="h in doc.headings" :key="h.id" :class="`l${Math.min(h.level, 4)}`" @click="jump(h.id)">{{ h.text }}</button>
          </div>
        </div>
      </div>
    </template>
    <template v-else-if="currentOverlay?.t === 'readset'">
      <div class="m-ovl">
        <div class="mask" @click="close()"></div>
        <div class="sheet">
          <div class="grab"></div>
          <h2>阅读设置</h2>
          <ReaderSettings />
          <p class="hint" style="padding: 0 16px">和“我的”页里的设置是同一份</p>
        </div>
      </div>
    </template>
    <ImageViewer v-else-if="currentOverlay?.t === 'image'" :src="currentOverlay.src" :alt="currentOverlay.alt" />
  </div>
</template>
