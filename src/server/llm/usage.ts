import { eq, sql } from "drizzle-orm";
import type { Clock } from "../clock";
import type { Db } from "../db";
import { llmUsage } from "./schema";

export interface Usage {
  today(): number;
  count(): void;
}

/** One row per UTC day; both adapters count through it, so the fake can rehearse the counter. */
export function createUsage(db: Db, clock: Clock): Usage {
  const day = () => clock.now().toISOString().slice(0, 10);
  return {
    today() {
      return db.select().from(llmUsage).where(eq(llmUsage.day, day())).get()?.requests ?? 0;
    },
    count() {
      db.insert(llmUsage)
        .values({ day: day(), requests: 1 })
        .onConflictDoUpdate({ target: llmUsage.day, set: { requests: sql`${llmUsage.requests} + 1` } })
        .run();
    },
  };
}
