import { createApp } from "vue";
import { createPinia } from "pinia";
import "@fontsource/libre-franklin/700.css";
import "@fontsource/source-serif-4/400.css";
import "./style.css";
import App from "./App.vue";
import router from "./router";
createApp(App).use(createPinia()).use(router).mount("#app");
