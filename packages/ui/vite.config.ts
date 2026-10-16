import { defineConfig } from "vite";

/** 静态 SPA：构建产物直接被 console server 托管。 */
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
