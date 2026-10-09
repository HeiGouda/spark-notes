<script setup lang="ts">
import Icon from "../Icon.vue";
import { formatTokens, modelLabel } from "../../lib/aiModels";
import { presetOf } from "../../lib/ai";
import { useMobileAi } from "../ai";
import { back, go } from "../nav";

const ai = useMobileAi();
</script>

<template>
  <div class="page bare">
    <div class="top">
      <button class="ib" @click="back()"><Icon name="back" /></button>
      <h1>AI 模型</h1>
    </div>
    <div class="scroll gray">
      <template v-if="ai.models.length">
        <div class="grp-t">默认模型</div>
        <div class="grp">
          <div class="row">
            <span class="main"><div class="name">{{ ai.defaultModel ? modelLabel(ai.defaultModel) : "" }}</div></span>
            <span class="v">
              <select class="plain" :value="ai.defaultModel?.id" @change="ai.setDefault(($event.target as HTMLSelectElement).value)">
                <option v-for="m in ai.models" :key="m.id" :value="m.id">{{ modelLabel(m) }}</option>
              </select>
            </span>
          </div>
        </div>
        <p class="ghint">助手里的新对话用这个模型，对话里可以临时切换。</p>
      </template>

      <div class="grp-t">全部模型</div>
      <div class="grp">
        <button v-for="m in ai.models" :key="m.id" class="row" @click="go({ p: 'ai-model', id: m.id })">
          <span class="main">
            <div class="name">{{ modelLabel(m) }}<span v-if="m.id === ai.defaultModel?.id" class="badge">默认</span></div>
            <div class="sub">{{ presetOf(m.provider).label }} · {{ m.name }} · {{ formatTokens(ai.contextOf(m).tokens) }}</div>
          </span>
          <span class="v"><Icon name="chev" :size="16" /></span>
        </button>
        <button class="row link" @click="go({ p: 'ai-model', id: null })">
          <span class="ic"><Icon name="plus" :size="20" /></span>
          <span class="main"><div class="name">添加模型</div></span>
        </button>
      </div>
      <p class="ghint">模型列表只存在这台手机上，不和电脑同步。API Key 存在手机的系统密钥库里。</p>
    </div>
  </div>
</template>
