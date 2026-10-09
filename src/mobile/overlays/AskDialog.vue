<script setup lang="ts">
import { answer, asking } from "../dialog";
</script>

<template>
  <Transition name="m-fade">
    <div v-if="asking" class="m-ovl ask-ovl">
      <div class="mask" @click="answer(false)"></div>
      <div class="dialog ask" role="alertdialog" :aria-label="asking.title">
        <h2>{{ asking.title }}</h2>
        <p v-if="asking.message">{{ asking.message }}</p>
        <label v-if="asking.check" class="ask-check">
          <input v-model="asking.checked" type="checkbox" />
          <span>{{ asking.check }}</span>
        </label>
        <div class="acts">
          <button class="btn text" @click="answer(false)">{{ asking.cancel ?? "取消" }}</button>
          <button class="btn" :class="asking.danger ? 'danger' : 'pri'" @click="answer(true)">{{ asking.ok ?? "确定" }}</button>
        </div>
      </div>
    </div>
  </Transition>
</template>
