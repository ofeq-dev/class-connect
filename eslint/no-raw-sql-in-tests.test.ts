import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";
import { noRawSqlInTests } from "./no-raw-sql-in-tests.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser as never, sourceType: "module" },
});

tester.run("no-raw-sql-in-tests", noRawSqlInTests, {
  valid: [
    { filename: "src/server/jobs/index.ts", code: `database.sqlite.prepare("select 1");` },
    { filename: "src/server/homework/review-run.test.ts", code: `t.jobs.tally("review.submission");` },
    { filename: "src/server/backup/backup.test.ts", code: `live.prepare("select count(*) from note");` },
  ],
  invalid: [
    {
      filename: "src/server/homework/review-run.test.ts",
      code: `t.database.sqlite.prepare("select status from job").all();`,
      errors: [{ messageId: "rawSql" }],
    },
    {
      filename: "src/server/feedback/feedback.test.ts",
      code: `sqlite.exec("delete from comment");`,
      errors: [{ messageId: "rawSql" }],
    },
  ],
});
