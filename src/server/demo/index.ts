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
} from "./rehearsal";
