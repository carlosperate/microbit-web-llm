import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname),
  // The local compiler (pxt-mkc) requires "path" at module top; without the
  // alias it fails open and set_code errors lose their diagnostics.
  resolve: { alias: { path: "path-browserify" } },
  build: { outDir: "../dist-test-page" },
});
