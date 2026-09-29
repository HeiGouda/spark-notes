<!-- 图标与 prototype/index.html 中的 SVG sprite 一致 -->
<template>
  <svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></symbol>
    <symbol id="i-sidebar" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></symbol>
    <symbol id="i-left" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></symbol>
    <symbol id="i-right" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></symbol>
    <symbol id="i-down" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></symbol>
    <symbol id="i-sync" viewBox="0 0 24 24"><path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"/><path d="M19 3v4.5h-4.5M5 21v-4.5h4.5"/></symbol>
    <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></symbol>
    <symbol id="i-settings" viewBox="0 0 24 24"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></symbol>
    <symbol id="i-min" viewBox="0 0 24 24"><path d="M6 12h12"/></symbol>
    <symbol id="i-max" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1"/></symbol>
    <symbol id="i-close" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></symbol>
    <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
    <symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/></symbol>
    <symbol id="i-folder-plus" viewBox="0 0 24 24"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/><path d="M12 10v6M9 13h6"/></symbol>
    <symbol id="i-file" viewBox="0 0 24 24"><path d="M6.5 3h7l4 4v13a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M13.5 3v4h4"/></symbol>
    <symbol id="i-file-plus" viewBox="0 0 24 24"><path d="M6.5 3h7l4 4v13a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M12 11v6M9 14h6"/></symbol>
    <symbol id="i-tag" viewBox="0 0 24 24"><path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.5 1.5 0 0 1 0 2.1l-6.2 6.2a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8" cy="8" r="1.4"/></symbol>
    <symbol id="i-star" viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.5 6 .7-4.4 4.1 1.2 6-5.4-3-5.4 3 1.2-6-4.4-4.1 6-.7z"/></symbol>
    <symbol id="i-outline" viewBox="0 0 24 24"><path d="M4 6h16M8 12h12M12 18h8"/></symbol>
    <symbol id="i-sort" viewBox="0 0 24 24"><path d="M4 6h10M4 12h7M4 18h4M17 5v14M14 16l3 3 3-3"/></symbol>
    <symbol id="i-collapse" viewBox="0 0 24 24"><path d="M7 20l5-5 5 5M7 4l5 5 5-5"/></symbol>
    <symbol id="i-undo" viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></symbol>
    <symbol id="i-redo" viewBox="0 0 24 24"><path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></symbol>
    <symbol id="i-code" viewBox="0 0 24 24"><path d="M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5"/></symbol>
    <symbol id="i-clear" viewBox="0 0 24 24"><path d="M5 5h14M12 5v6M10 19h4M4 20L20 4"/></symbol>
    <symbol id="i-ul" viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".9"/><circle cx="4.5" cy="12" r=".9"/><circle cx="4.5" cy="18" r=".9"/></symbol>
    <symbol id="i-ol" viewBox="0 0 24 24"><path d="M10 6h10M10 12h10M10 18h10M4 4.5h1.5V9M3.5 9h3.5M3.8 14.5a1.5 1.5 0 0 1 2.7 1c0 1-3 1.8-3 3.5h3.2"/></symbol>
    <symbol id="i-task" viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="6" height="6" rx="1.2"/><path d="M5 7.6l1.2 1.2 2-2.2M13 7.5h7.5"/><rect x="3.5" y="13.5" width="6" height="6" rx="1.2"/><path d="M13 16.5h7.5"/></symbol>
    <symbol id="i-indent" viewBox="0 0 24 24"><path d="M3 5h18M11 10h10M11 14h10M3 19h18M3 9l3.5 3L3 15"/></symbol>
    <symbol id="i-outdent" viewBox="0 0 24 24"><path d="M3 5h18M11 10h10M11 14h10M3 19h18M7 9l-3.5 3L7 15"/></symbol>
    <symbol id="i-quote" viewBox="0 0 24 24"><path d="M5 17c2.5-.5 4-2.3 4-5V7H4.5v5H9M15 17c2.5-.5 4-2.3 4-5V7h-4.5v5H19"/></symbol>
    <symbol id="i-codeblock" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9.5 9.5L7 12l2.5 2.5M14.5 9.5L17 12l-2.5 2.5"/></symbol>
    <symbol id="i-hr" viewBox="0 0 24 24"><path d="M3 12h18M7 7h10M7 17h10" opacity=".35"/><path d="M3 12h18"/></symbol>
    <symbol id="i-link" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3.2-3.2a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3.2 3.2a4 4 0 0 0 5.7 5.7l1-1"/></symbol>
    <symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-9.5 9"/></symbol>
    <symbol id="i-table" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9.5h18M3 15h18M9 4v16M15 4v16"/></symbol>
    <symbol id="i-replace" viewBox="0 0 24 24"><path d="M4 8h12l-3-3M20 16H8l3 3"/></symbol>
    <symbol id="i-tidy" viewBox="0 0 24 24"><path d="M4 7h8M4 12h12M4 17h8"/><path d="M18 3.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/></symbol>
    <symbol id="i-sparkle" viewBox="0 0 24 24"><path d="M11 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1-5.1-1.9 5.1-1.9z"/><path d="M18.5 15l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z"/></symbol>
    <symbol id="i-summary" viewBox="0 0 24 24"><path d="M5 5h14M5 10h14M5 15h8"/><path d="M16 15.5l1.8 1.8 3.2-3.6"/></symbol>
    <symbol id="i-structure" viewBox="0 0 24 24"><rect x="3.5" y="4" width="7" height="5" rx="1"/><rect x="13.5" y="10" width="7" height="4" rx="1"/><rect x="13.5" y="16" width="7" height="4" rx="1"/><path d="M7 9v9h6.5M7 12h6.5"/></symbol>
    <symbol id="i-alert" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.2v.3"/></symbol>
    <symbol id="i-chat" viewBox="0 0 24 24"><path d="M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4.5 3.5v-3.5h-1a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/></symbol>
    <symbol id="i-clip" viewBox="0 0 24 24"><path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/></symbol>
    <symbol id="i-send" viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></symbol>
    <symbol id="i-stop" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></symbol>
    <symbol id="i-dots" viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/></symbol>
    <symbol id="i-insert" viewBox="0 0 24 24"><path d="M5 5h14M5 19h14M12 8v8M8.5 12.5L12 16l3.5-3.5"/></symbol>
    <symbol id="i-trash" viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></symbol>
    <symbol id="i-edit" viewBox="0 0 24 24"><path d="M5 19h4L19 9l-4-4L5 15z"/></symbol>
    <symbol id="i-key" viewBox="0 0 24 24"><circle cx="8" cy="14" r="4"/><path d="M11 11.5L19 4M16 7l2.5 2.5M14 9l2 2"/></symbol>
    <symbol id="i-copy" viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/></symbol>
    <symbol id="i-more" viewBox="0 0 24 24"><path d="M13 7l5 5-5 5M6 7l5 5-5 5"/></symbol>
    <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></symbol>
    <symbol id="i-git" viewBox="0 0 24 24"><circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7.5v9M18 10c0 4-6 3.5-11 7"/></symbol>
    <symbol id="i-pull" viewBox="0 0 24 24"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></symbol>
    <symbol id="i-push" viewBox="0 0 24 24"><path d="M12 20V9M7 13.5l5-5 5 5M5 4h14"/></symbol>
    <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></symbol>
    <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></symbol>
  </svg>
</template>
