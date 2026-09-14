import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";

// https://vitejs.dev/config/
export default defineConfig({
  base: "/benches/",
  plugins: [vue(), vueJsx()],
  // MapLibre creates its worker with a module URL. Let Vite process the
  // package directly instead of rewriting it through the dependency optimizer.
  optimizeDeps: {
    exclude: ["maplibre-gl"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'maplibre': ['maplibre-gl'],
          'pmtiles': ['pmtiles'],
          'hyparquet': ['hyparquet'],
        },
      },
    },
  },
});
