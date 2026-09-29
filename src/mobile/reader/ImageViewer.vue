<script setup lang="ts">
import { reactive } from "vue";
import Icon from "../Icon.vue";
import { close } from "../nav";

defineProps<{ src: string; alt: string }>();

/* 画面以左上角为原点缩放：屏幕上的点 p 对应图上 (p - t) / k */
const view = reactive({ k: 1, x: 0, y: 0 });
const MAX = 6;

interface Gesture {
  k: number;
  x: number;
  y: number;
  dist: number;
  mx: number;
  my: number;
  moved: boolean;
  startedAt: number;
}

let g: Gesture | null = null;

const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
const mid = (t: TouchList) =>
  t.length > 1 ? [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2] : [t[0].clientX, t[0].clientY];

function begin(e: TouchEvent) {
  const [mx, my] = mid(e.touches);
  g = {
    k: view.k,
    x: view.x,
    y: view.y,
    dist: e.touches.length > 1 ? dist(e.touches) : 0,
    mx,
    my,
    moved: g?.moved ?? false,
    startedAt: g?.startedAt ?? Date.now(),
  };
}

function onStart(e: TouchEvent) {
  if (e.touches.length === 1) g = null;
  begin(e);
}

function onMove(e: TouchEvent) {
  if (!g) return;
  e.preventDefault();
  const [mx, my] = mid(e.touches);
  if (e.touches.length > 1 && g.dist) {
    const k = Math.min(MAX, Math.max(1, (g.k * dist(e.touches)) / g.dist));
    view.x = mx - ((g.mx - g.x) * k) / g.k;
    view.y = my - ((g.my - g.y) * k) / g.k;
    view.k = k;
    g.moved = true;
  } else if (e.touches.length === 1) {
    const dx = mx - g.mx;
    const dy = my - g.my;
    if (Math.hypot(dx, dy) > 8) g.moved = true;
    if (view.k > 1) {
      view.x = g.x + dx;
      view.y = g.y + dy;
    }
  }
}

function onEnd(e: TouchEvent) {
  if (!g) return;
  if (e.touches.length) {
    begin(e);
    return;
  }
  const tap = !g.moved && Date.now() - g.startedAt < 300;
  g = null;
  if (view.k <= 1.01) Object.assign(view, { k: 1, x: 0, y: 0 });
  if (tap) close();
}
</script>

<template>
  <div class="imgfull" @touchstart="onStart" @touchmove="onMove" @touchend="onEnd" @touchcancel="onEnd">
    <div class="imgfull-stage" :style="{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }">
      <img :src="src" :alt="alt" draggable="false" />
    </div>
    <button class="ib x" title="关闭" @touchend.stop @click="close()"><Icon name="x" /></button>
    <div class="tip">双指缩放 · 轻点关闭</div>
  </div>
</template>
