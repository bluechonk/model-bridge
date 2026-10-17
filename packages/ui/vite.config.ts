import { defineConfig } from "vite";

/**
 * 静态 SPA：构建产物被 console server 托管。
 *
 * `base` 必须是 `/web/` —— 单端口模式下 UI 挂在网关的 `/web` 前缀下，
 * 产物里的资源引用（`/web/assets/*.js`）与实际路由一致才不会 404。
 */
export default defineConfig({
  base: "/web/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
