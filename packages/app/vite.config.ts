import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  // makecode-mcp's local compiler (pxt-mkc) requires "path" at module top;
  // load-bearing for any bundler consuming makecode-mcp/browser.
  resolve: { alias: { path: "path-browserify" } },
  server: { port: 5173 },
});
