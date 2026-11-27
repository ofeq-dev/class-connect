import path from "node:path";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";
import { moduleBoundaries } from "./module-boundaries.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser as never, sourceType: "module" },
});
const cwd = process.cwd();
const at = (rel: string) => path.join(cwd, rel);

tester.run("module-boundaries", moduleBoundaries, {
  valid: [
    { filename: at("src/server/http/app.ts"), code: `import { x } from "../course";` },
    { filename: at("src/server/http/app.ts"), code: `import { x } from "../course/index";` },
    { filename: at("src/server/course/index.ts"), code: `import { course } from "./schema";` },
    { filename: at("src/server/course/index.ts"), code: `import { DomainError } from "../errors";` },
    { filename: at("src/client/api.ts"), code: `import type { AppType } from "../server/http";` },
    { filename: at("src/client/api.ts"), code: `import { NOTICE_TYPES } from "../shared/notices";` },
  ],
  invalid: [
    {
      filename: at("src/server/attendance/index.ts"),
      code: `import { course } from "../course/schema";`,
      errors: [{ messageId: "internals" }],
    },
    {
      filename: at("src/server/http/app.ts"),
      code: `export { hashPassword } from "../lecturer-auth/password";`,
      errors: [{ messageId: "internals" }],
    },
    {
      filename: at("src/client/api.ts"),
      code: `import { createApp } from "../server/http";`,
      errors: [{ messageId: "clientValue" }],
    },
  ],
});
