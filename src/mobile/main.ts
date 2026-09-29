import { createApp } from "vue";
import { createPinia } from "pinia";
import "../styles/tokens.css";
import "./mobile.css";
import App from "./App.vue";
import { installBackButton } from "./nav";

installBackButton();
createApp(App).use(createPinia()).mount("#app");
