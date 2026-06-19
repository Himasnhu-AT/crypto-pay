import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  target: "es2022",
  // viem is a peer dependency — never bundle it; the host app dedupes one copy.
  external: ["viem"],
});
