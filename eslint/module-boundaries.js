// @ts-check
import path from "node:path";
import { noRawSqlInTests } from "./no-raw-sql-in-tests.js";

/**
 * Keeps modules deep (docs/diagrams/class-diagram.md):
 * - Under src/server, each top-level folder is a module. Code outside a module may import only
 *   its index (the module's interface), never a file inside it.
 * - The front end (src/client) may import server code for types only (Hono's typed client).
 */

const SERVER = path.join("src", "server") + path.sep;
const CLIENT = path.join("src", "client") + path.sep;

/** @param {string} file @param {string} root */
function locate(file, root) {
  const rel = path.relative(root, file);
  if (rel.startsWith(SERVER)) {
    const parts = rel.slice(SERVER.length).split(path.sep);
    return { area: "server", module: parts.length > 1 ? parts[0] : null, rest: parts.slice(1) };
  }
  if (rel.startsWith(CLIENT)) return { area: "client", module: null, rest: [] };
  return { area: "other", module: null, rest: [] };
}

/** @type {import("eslint").Rule.RuleModule} */
export const moduleBoundaries = {
  meta: {
    type: "problem",
    docs: { description: "Import other modules only through their index" },
    messages: {
      internals:
        "'{{source}}' reaches into the {{module}} module. Import its interface ('{{module}}' index) instead.",
      clientValue:
        "The front end may import server code for types only. Use 'import type' for '{{source}}'.",
    },
    schema: [],
  },
  create(context) {
    const root = context.cwd;
    const file = context.filename;
    const from = locate(file, root);

    /** @param {import("estree").ImportDeclaration | import("estree").ExportNamedDeclaration | import("estree").ExportAllDeclaration} node */
    function check(node) {
      const source = node.source && typeof node.source.value === "string" ? node.source.value : null;
      if (!source || !source.startsWith(".")) return;
      const target = locate(path.resolve(path.dirname(file), source), root);
      if (target.area !== "server") return;

      if (from.area === "client") {
        // importKind / exportKind come from the TypeScript parser.
        const kinds = /** @type {{ importKind?: string, exportKind?: string }} */ (/** @type {unknown} */ (node));
        if (kinds.importKind !== "type" && kinds.exportKind !== "type") {
          context.report({ node, messageId: "clientValue", data: { source } });
        }
        return;
      }

      if (!target.module || target.module === from.module) return;
      const inner = target.rest.join("/").replace(/\.(ts|tsx|js)$/, "");
      if (inner === "" || inner === "index") return;
      context.report({ node, messageId: "internals", data: { source, module: target.module } });
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
    };
  },
};

export default { rules: { "module-boundaries": moduleBoundaries, "no-raw-sql-in-tests": noRawSqlInTests } };
