import { build } from "esbuild";

await build({
  entryPoints: ["src/server/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  outfile: "dist/server/main.js",
  sourcemap: true,
});
