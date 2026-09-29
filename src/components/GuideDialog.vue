<script setup lang="ts">
import { h, onBeforeUnmount, onMounted, ref, type FunctionalComponent } from "vue";
import Icon from "./Icon.vue";
import { shortcutOf } from "../lib/commands";
import { displayShortcut } from "../lib/shortcut";
import { isMac } from "../lib/platform";
import { useUiStore } from "../stores/ui";

/** 操作指南：帮助菜单打开，按主题分页介绍基本用法 */
const ui = useUiStore();

const SECTIONS = [
  ["start", "开始使用"],
  ["edit", "编辑笔记"],
  ["organize", "整理与查找"],
  ["safe", "备份与同步"],
  ["ai", "AI 功能"],
  ["more", "个性化"],
] as const;
type SectionId = (typeof SECTIONS)[number][0];
const section = ref<SectionId>("start");

/** 按用户当前的快捷键显示；该命令没有快捷键时不显示 */
const Key: FunctionalComponent<{ id: string }> = (props) => {
  const s = shortcutOf(props.id);
  if (!s) return null;
  return h("span", { class: "kbd" }, displayShortcut(s).split("+").map((k) => h("span", k)));
};
Key.props = ["id"];

function close() {
  ui.guideOpen = false;
}

function openSettings(id: string) {
  close();
  ui.settingsSection = id;
  ui.settingsOpen = true;
}

function onKey(e: KeyboardEvent) {
  if (!ui.guideOpen || e.key !== "Escape") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  close();
}

onMounted(() => window.addEventListener("keydown", onKey, true));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <div v-if="ui.guideOpen" class="mask" @mousedown.self="close()">
    <div class="pop settings" role="dialog" aria-label="操作指南">
      <div class="keys-head">
        <h3>操作指南</h3>
        <button class="btn" type="button" title="关闭 (Esc)" @click="close()"><Icon name="close" sm /></button>
      </div>
      <div class="settings-body">
        <nav class="settings-nav">
          <button v-for="[id, label] in SECTIONS" :key="id" type="button" class="settings-tab" :class="{ on: section === id }" @click="section = id">{{ label }}</button>
        </nav>
        <div class="settings-main guide">
          <template v-if="section === 'start'">
            <h4>1. 打开笔记库</h4>
            <p>笔记库就是电脑上的一个普通文件夹，每篇笔记是其中的一个 Markdown（.md）文件。点标题栏左上角的菜单，选“文件 → 打开笔记库…”，选择一个文件夹即可（可以是空文件夹）。以后再打开软件，会自动回到上次的笔记库。</p>
            <p>有多个笔记库时，用“文件 → 切换笔记库”在它们之间切换。</p>
            <h4>2. 新建笔记和文件夹</h4>
            <ul>
              <li>新建笔记 <Key id="file.newNote" />：也可以点标签栏右边的“+”。</li>
              <li>新建文件夹 <Key id="file.newFolder" />：侧栏顶部也有对应按钮。</li>
              <li>新笔记会建在当前选中的文件夹里，建好后直接输入名字。</li>
            </ul>
            <h4>3. 不用手动保存</h4>
            <p>输入的内容会自动保存到文件，底部状态栏右侧显示“已保存”。想立即保存可以按 <Key id="file.save" />。</p>
            <h4>4. 界面组成</h4>
            <ul>
              <li><b>左侧栏</b>：顶部一排图标依次是文件、搜索、标签、收藏、大纲、版本控制；底部是“AI 对话”。</li>
              <li><b>标题栏</b>：菜单、显示 / 隐藏侧栏 <Key id="view.toggleSidebar" />、后退 / 前进、已打开的笔记标签页；右边是同步、搜索、夜读、设置。</li>
              <li><b>格式工具栏</b>：编辑区上方，常用格式一键设置。</li>
              <li><b>状态栏</b>：底部，显示字数、光标位置和保存状态。</li>
            </ul>
          </template>

          <template v-else-if="section === 'edit'">
            <h4>所见即所得</h4>
            <p>直接编辑排版后的效果，不需要记 Markdown 语法；如果习惯 Markdown，输入 <code># </code>、<code>- </code>、<code>&gt; </code> 等也会自动转换。</p>
            <h4>设置格式的三种方式</h4>
            <ul>
              <li><b>格式工具栏</b>：点按钮设置标题、加粗、列表、代码块、表格等。在工具栏上点右键可以选择显示哪些按钮。</li>
              <li><b>浮动格式条</b>：选中一段文字，旁边会弹出加粗、斜体、链接等常用按钮。</li>
              <li><b>斜杠菜单</b>：在空行输入 <code>/</code>，从列表里选择要插入的标题、列表、表格、图片、分割线等。继续输入可以筛选，支持拼音首字母，比如 <code>/bg</code> 找到“表格”。</li>
            </ul>
            <h4>图片和附件</h4>
            <p>把图片或文件直接粘贴、拖进正文即可，文件会保存在笔记旁边的“笔记名.assets”文件夹里（侧边栏不显示这个文件夹）。选中图片后可以点“放大”“缩小”，或拖动右下角调整大小。也可以用插入图片 <Key id="insert.image" /> 选择本地图片。</p>
            <h4>链接与标签</h4>
            <ul>
              <li>插入网址链接 <Key id="insert.link" />；点击链接即可在浏览器打开。只写了 www.baidu.com 这种没带 http 的地址也可以打开。指向另一篇笔记的链接会打开那篇笔记。</li>
              <li>输入 <code>[[</code> 会弹出笔记列表，选中后生成指向另一篇笔记的“双向链接”，点击即可跳转。被链接的笔记底部会列出有哪些笔记链接到了它。</li>
              <li>给笔记打标签：点标题下方的“+ 标签”输入标签名，或者在正文里直接写 <code>#标签</code>（<code>#</code> 后不要加空格）。标签名里的 <code>/</code> 表示层级，例如 <code>#哲学/辩证法</code>。之后可以在左栏“标签”视图里按标签查看笔记。</li>
            </ul>
            <h4>查找替换与一键整理</h4>
            <ul>
              <li>在当前笔记里查找 <Key id="edit.find" />，替换 <Key id="edit.replace" />。</li>
              <li>一键整理 <Key id="format.tidy" />：自动在中英文之间加空格、统一标点、去掉多余空行等。整理后不满意，按 <Key id="edit.undo" /> 撤销。</li>
            </ul>
            <p>想改笔记名，可以直接修改正文顶部的大标题。</p>
          </template>

          <template v-else-if="section === 'organize'">
            <h4>文件树</h4>
            <ul>
              <li>单击打开笔记；用鼠标拖动笔记或文件夹，可以移到别的文件夹里。</li>
              <li>右键笔记或文件夹可以重命名（F2）、删除（{{ isMac ? "Cmd+Backspace" : "Delete" }}）、收藏、复制路径、{{ isMac ? "在访达中显示" : "在资源管理器中打开" }}。</li>
              <li>删除的内容会先进入回收站，不会立刻消失。</li>
            </ul>
            <h4>标签页</h4>
            <ul>
              <li>单击笔记打开的是“预览”标签页（标题为斜体），再打开别的笔记会替换它；开始编辑或双击标签页后会固定下来。</li>
              <li>拖动标签页可以调整顺序；右键可以关闭其他或关闭右侧的标签页；点鼠标中键直接关闭。</li>
              <li>切换标签页 <Key id="tab.next" />，关闭当前标签页 <Key id="tab.close" />，后退 / 前进 <Key id="nav.back" /> <Key id="nav.forward" />。</li>
            </ul>
            <h4>找到笔记</h4>
            <ul>
              <li><b>快速打开</b> <Key id="palette.files" />：输入笔记名的一部分，回车打开。</li>
              <li><b>全文搜索</b> <Key id="search.focus" />：搜索所有笔记的内容。可以用 <code>#标签</code> 或 <code>path:文件夹</code> 缩小范围。</li>
              <li><b>标签、收藏、大纲</b>：左栏对应视图里分别按标签浏览、查看收藏的笔记、查看当前笔记的目录并点击跳转。</li>
            </ul>
            <h4>命令面板</h4>
            <p>记不住某个功能在哪里时，按 <Key id="palette.commands" /> 打开命令面板，输入功能名称（例如“回收站”“夜读”）直接执行。</p>
          </template>

          <template v-else-if="section === 'safe'">
            <h4>历史版本</h4>
            <p>软件会自动保存笔记的旧版本。在菜单“文件 → 历史版本”里可以查看、和当前内容对比，并恢复到以前的某个版本。</p>
            <h4>回收站</h4>
            <p>删除的笔记和文件夹在“文件 → 回收站”里，可以恢复到原来的位置。默认保留 30 天，天数可在设置 → 历史与回收站里修改。</p>
            <h4>在多台电脑之间同步</h4>
            <p>在 <a href="#" @click.prevent="openSettings('sync')">设置 → 同步</a> 里选择一种方式：</p>
            <ul>
              <li><b>WebDAV</b>：填写网盘（例如坚果云）的 WebDAV 地址、账号和密码。云端是正本：点标题栏右侧的同步按钮，选“上传本地改动”把这台电脑的改动传上去，选“从云端同步”把云端的内容拿下来。会覆盖或删除文件时先列出清单让你确认，被覆盖的笔记可以在历史版本里找回。</li>
              <li><b>Git</b>：需要先安装 {{ isMac ? "Git（运行 xcode-select --install 或用 Homebrew 安装）" : "Git for Windows" }}。填写远程仓库地址后点“连接”，需要登录时填写账号和访问令牌。左栏“版本控制”视图可以提交、拉取、推送，标题栏同步按钮一键先拉取再推送；两台电脑改了同一篇笔记时两份都会保留。</li>
            </ul>
            <h4>导入与导出</h4>
            <p>“文件 → 导出笔记库”把整个笔记库打包成一个 zip 文件，方便备份或拷到别的电脑；“文件 → 导入笔记库”把这样的 zip 还原成一个新的笔记库。</p>
          </template>

          <template v-else-if="section === 'ai'">
            <h4>先配置 AI</h4>
            <p>在 <a href="#" @click.prevent="openSettings('ai')">设置 → AI</a> 里选择服务商，填写 API Key 和模型名，点“测试连接”确认可用。也可以使用本机运行的模型（Ollama、LM Studio），这时不需要 API Key。</p>
            <p>只有在你点击 AI 功能时，才会把相关内容发送给 AI 服务商。</p>
            <h4>可以做什么</h4>
            <ul>
              <li><b>AI 指令</b>：在正文空行输入 <code>/ai</code>，写下要求（例如“把这段改得更通顺”“列一个提纲”）。结果先显示在待确认区域，你可以接受、放弃或重新生成。</li>
              <li><b>总结与整理结构</b>：点格式工具栏右侧的“AI”，可以总结当前笔记，或者让 AI 重新整理笔记的层次结构（替换前会左右对比，并自动保存一份历史版本）。</li>
              <li><b>AI 对话</b>：点左栏底部的“AI 对话”，像聊天一样提问。可以发送图片和文件，输入 <code>@</code> 引用某篇笔记；满意的回答可以插入到笔记或保存为新笔记。</li>
            </ul>
          </template>

          <template v-else>
            <h4>外观</h4>
            <ul>
              <li>共有五套主题：浅色、纸张、护眼、夜读、纯黑，可在菜单“视图 → 主题”或 <a href="#" @click.prevent="openSettings('look')">设置 → 外观</a> 里选择。</li>
              <li>点标题栏右侧的月亮 / 太阳图标，在上次使用的浅色主题和深色主题之间切换。</li>
              <li>在菜单“视图”里可以隐藏侧栏、格式工具栏和状态栏，获得更干净的写作界面。</li>
              <li>界面缩放在 <a href="#" @click.prevent="openSettings('look')">设置 → 外观</a> 里修改；正文的字体、字号、行高和宽度在 <a href="#" @click.prevent="openSettings('editor')">设置 → 编辑器</a> 里修改。</li>
            </ul>
            <h4>快捷键</h4>
            <p>本指南里显示的都是你当前使用的快捷键。在 <a href="#" @click.prevent="openSettings('keys')">设置 → 快捷键</a> 里可以查看全部快捷键：点击某一行，再按下新的组合键就能修改。把鼠标停在按钮上，也会提示对应的快捷键。</p>
            <h4>设置</h4>
            <p>按 <Key id="app.settings" /> 或点标题栏右侧的齿轮图标打开设置，可以调整启动行为、编辑器、同步、历史保留天数和 AI 等。</p>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
