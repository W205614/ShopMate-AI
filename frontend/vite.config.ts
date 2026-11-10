import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  build: {
    license: { fileName: "licenses/dependencies.md" },
    rolldownOptions: {
      output: {
        postBanner: "/* Dependency licenses: /licenses/dependencies.md */",
        codeSplitting: {
          groups: [
            {
              name: "admin-ui",
              test: /node_modules[\\/]element-plus/,
              maxSize: 250_000,
            },
          ],
        },
      },
    },
  },
  server: { proxy: { "/api": "http://127.0.0.1:3001" } },
});
