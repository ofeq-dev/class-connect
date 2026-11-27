// @ts-check

/**
 * docs/testing-strategy.md, Principles: "Tests never reach into a module's tables or private
 * functions." A test that runs SQL on the app database (`<x>.sqlite.prepare/exec`) is reading or
 * writing some module's tables; go through that module's interface instead. Importing another
 * module's schema.ts is already caught by module-boundaries.
 */

/** @type {import("eslint").Rule.RuleModule} */
export const noRawSqlInTests = {
  meta: {
    type: "problem",
    docs: { description: "Tests use module interfaces, not SQL on the app database" },
    messages: {
      rawSql:
        "Tests never reach into a module's tables (docs/testing-strategy.md). Use the module's interface instead of sqlite.{{method}}().",
    },
    schema: [],
  },
  create(context) {
    if (!/\.test\.tsx?$/.test(context.filename)) return {};
    return {
      /** @param {import("estree").CallExpression} node */
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier") return;
        const method = callee.property.name;
        if (method !== "prepare" && method !== "exec") return;
        const owner = callee.object;
        const isSqlite =
          (owner.type === "MemberExpression" && owner.property.type === "Identifier" && owner.property.name === "sqlite") ||
          (owner.type === "Identifier" && owner.name === "sqlite");
        if (isSqlite) context.report({ node, messageId: "rawSql", data: { method } });
      },
    };
  },
};
