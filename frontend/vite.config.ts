import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 3000,
    proxy: {
      // 开发时前端请求 /api 与 /file 直接转发到 Python 后端
      "/api": "http://localhost:8000",
      "/file": "http://localhost:8000",
    },
  },
});
