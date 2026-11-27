import { defineConfig } from "drizzle-kit";

// Each module owns its tables in its own schema file (docs/diagrams/class-diagram.md).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/*/schema.ts",
  out: "./drizzle",
});
