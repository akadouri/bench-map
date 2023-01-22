import { createApp } from "vue";
import App from "./App.vue";
import VSelect from "vue-select";

import "./assets/main.css";

// https://stackoverflow.com/questions/66537320/vue-3-event-bus-with-composition-api/66538941#66538941
import mitt from "mitt"; // Import mitt
const emitter = mitt(); // Initialize mitt

const app = createApp(App);
app.provide("emitter", emitter);
app.component("v-select", VSelect);
app.mount("#app");
