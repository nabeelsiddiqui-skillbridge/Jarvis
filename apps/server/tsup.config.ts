import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/api.ts", "src/worker.ts", "src/db/migrate.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Bundle the shared workspace package (it ships TypeScript source).
  noExternal: ["@bca/shared"],
});
