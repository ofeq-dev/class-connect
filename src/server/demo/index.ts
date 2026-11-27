/**
 * Demo: the rehearsal fixtures behind the fake LLM (`LLM_ADAPTER=fake`) and `seed:demo`, which
 * builds the demo Course through module operations only (spec #20, "Demo seed and rehearsal fixtures").
 */
export {
  createRehearsalGateway,
  FIXTURES_DIR,
  loadRehearsalFixtures,
  type RehearsalFixtures,
  type RehearsalGatewayDeps,
  scriptRehearsalReplies,
} from "./rehearsal";
export { DEMO_COURSE_NAME, seedDemo, type SeedDeps, type SeedOptions, type SeedResult, type SettableClock } from "./seed";
