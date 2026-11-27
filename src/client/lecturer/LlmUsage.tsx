import { useLlmUsage } from "./queries";

/** "LLM requests today: 37 / 1000", in the desk header and the live console's ⋯ menu. */
export function LlmUsage() {
  const usage = useLlmUsage();
  if (!usage.data) return null;
  return (
    <span className="muted small num">
      LLM requests today: {usage.data.today} / {usage.data.limit}
    </span>
  );
}
