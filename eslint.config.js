// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import boundaries from "./eslint/module-boundaries.js";

export default tseslint.config(
  { ignores: ["dist/", "drizzle/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    plugins: { local: boundaries },
    rules: {
      "local/module-boundaries": "error",
      "local/no-raw-sql-in-tests": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
