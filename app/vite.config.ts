import { defineConfig } from "vite-plus";

export default defineConfig({
  root: "webui",
  build: { outDir: "../dist", emptyOutDir: true },
  test: { root: ".", env: { REVIEW_ORG: "example-org" }, include: ["src/**/*.test.ts", "webui/**/*.test.ts"] },
});
