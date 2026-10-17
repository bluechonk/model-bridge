import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

/**
 * 静态 SPA：构建产物被 console server 托管。
 *
 * - `base` 必须是 `/web/` —— 单端口模式下 UI 挂在网关的 `/web` 前缀下，
 *   产物里的资源引用（`/web/assets/*.js`）与实际路由一致才不会 404。
 *   ⚠ 仅设 `base` 不够：`BrowserRouter` 也要设 `basename="/web"`（见 `src/App.tsx`）。
 * - tailwind 插件：组件用工具类名组织样式（`src/index.css` 里 `@import "tailwindcss"`）。
 */
export default defineConfig({
  base: "/web/",
  plugins: [tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
