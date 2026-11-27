import { build } from "esbuild";

await build({
  entryPoints: {
    main: "src/server/main.ts",
    backup: "src/server/backup-cli.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  outdir: "dist/server",
  sourcemap: true,
});
