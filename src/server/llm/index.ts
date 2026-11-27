/**
 * LLM gateway (docs/diagrams/class-diagram.md): `generate(task, input) → typed result | LlmError`,
 * `embed`, `usageToday`. Two adapters: OpenRouter, and the scripted fake (`LLM_ADAPTER=fake`).
 */
export * from "./types";
export { createOpenRouterGateway, type OpenRouterDeps } from "./openrouter";
export { createScriptedGateway, type ScriptedGateway, type ScriptedDeps } from "./scripted";
