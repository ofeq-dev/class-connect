import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db";
import { FakeClock } from "../testing";
import { createOpenRouterGateway, DAILY_LIMIT, type LlmTask } from ".";

interface Sent {
  url: string;
  body: {
    model: string;
    messages: { role: string; content: string }[];
    input?: string[];
    provider?: { data_collection?: string };
  };
  at: number;
}

let database: OpenedDatabase;
let clock: FakeClock;
let sent: Sent[];
/** What the stubbed OpenRouter does with each request, by model. */
let reply: (body: Sent["body"], signal: AbortSignal) => Promise<Response>;

const MODELS = ["model/a:free", "model/b:free", "model/c:free"];

const ok = (content: string) =>
  Promise.resolve(Response.json({ choices: [{ message: { role: "assistant", content } }] }));

const echoTask: LlmTask<string, { answer: string }> = {
  name: "echo",
  timeoutMs: 50,
  prompt: (input) => `Reply with JSON {"answer": string} for: ${input}`,
  parse(reply) {
    const r = reply as { answer?: unknown };
    if (!r || typeof r.answer !== "string") throw new Error("answer must be a string");
    return { answer: r.answer };
  },
};

function gateway(options: { models?: string[]; apiKey?: string; dailyLimit?: number } = {}) {
  return createOpenRouterGateway({
    db: database.db,
    clock,
    apiKey: options.apiKey ?? "test-key",
    models: options.models ?? MODELS,
    embeddingModel: "embed/model:free",
    dailyLimit: options.dailyLimit,
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Sent["body"];
      sent.push({ url: String(url), body, at: clock.now().getTime() });
      return reply(body, init!.signal!);
    },
    // Waiting moves the fake Clock instead of real time.
    sleep: async (ms) => clock.advance(ms),
  });
}

beforeEach(() => {
  database = openDatabase(":memory:", path.resolve(process.cwd(), "drizzle"));
  clock = new FakeClock();
  sent = [];
  reply = () => ok(JSON.stringify({ answer: "hi" }));
});
afterEach(() => database.close());

describe("OpenRouter gateway", () => {
  it("sends the task prompt to the first model with data collection denied, and returns the parsed reply", async () => {
    const result = await gateway().generate(echoTask, "hello");
    expect(result).toEqual({ ok: true, value: { answer: "hi" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent[0]!.body.model).toBe("model/a:free");
    expect(sent[0]!.body.provider?.data_collection).toBe("deny");
    expect(sent[0]!.body.messages.at(-1)!.content).toContain("for: hello");
  });

  it("accepts a reply wrapped in a Markdown code fence", async () => {
    reply = () => ok('```json\n{"answer": "fenced"}\n```');
    expect(await gateway().generate(echoTask, "x")).toEqual({ ok: true, value: { answer: "fenced" } });
  });

  it("tries the fallback list in order until a model answers", async () => {
    reply = (body) =>
      body.model === "model/c:free" ? ok('{"answer":"from c"}') : Promise.resolve(new Response("busy", { status: 429 }));
    const result = await gateway().generate(echoTask, "x");
    expect(result).toEqual({ ok: true, value: { answer: "from c" } });
    expect(sent.map((s) => s.body.model)).toEqual(MODELS);
  });

  it("returns an LlmError when every model fails", async () => {
    reply = () => Promise.resolve(new Response("down", { status: 502 }));
    const result = await gateway().generate(echoTask, "x");
    expect(result).toMatchObject({ ok: false, error: { kind: "all-models-failed" } });
    expect(sent).toHaveLength(3);
  });

  it("counts a timeout as a failure and moves on to the next model", async () => {
    reply = (body, signal) =>
      body.model === "model/a:free"
        ? new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
        : ok('{"answer":"from b"}');
    const result = await gateway().generate(echoTask, "x");
    expect(result).toEqual({ ok: true, value: { answer: "from b" } });
    expect(sent.map((s) => s.body.model)).toEqual(["model/a:free", "model/b:free"]);
  });

  it("gives a reply that fails the schema one fix-up retry on the same model", async () => {
    let n = 0;
    reply = () => (++n === 1 ? ok('{"answer": 42}') : ok('{"answer":"fixed"}'));
    const result = await gateway({ models: ["model/a:free"] }).generate(echoTask, "x");
    expect(result).toEqual({ ok: true, value: { answer: "fixed" } });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.model).toBe("model/a:free");
    const fixUp = sent[1]!.body.messages;
    expect(fixUp.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(fixUp[1]!.content).toBe('{"answer": 42}');
    expect(fixUp[2]!.content).toMatch(/answer must be a string/);
  });

  it("returns an invalid-reply LlmError when the fix-up also fails", async () => {
    reply = () => ok("not json at all");
    const result = await gateway({ models: ["model/a:free"] }).generate(echoTask, "x");
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid-reply" } });
    expect(sent).toHaveLength(2);
  });

  it("runs one call at a time", async () => {
    let inFlight = 0;
    let most = 0;
    reply = async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return ok('{"answer":"hi"}');
    };
    const g = gateway();
    await Promise.all([g.generate(echoTask, "1"), g.generate(echoTask, "2"), g.generate(echoTask, "3")]);
    expect(most).toBe(1);
    expect(sent).toHaveLength(3);
  });

  it("sends at most 15 requests a minute", async () => {
    const g = gateway();
    const start = clock.now().getTime();
    for (let i = 0; i < 16; i++) await g.generate(echoTask, String(i));
    expect(sent.slice(0, 15).every((s) => s.at === start)).toBe(true);
    expect(sent[15]!.at).toBeGreaterThanOrEqual(start + 60_000);
  });

  it("counts each request in llm_usage for the day", async () => {
    const g = gateway();
    expect(g.usageToday()).toBe(0);
    reply = (body) =>
      body.model === "model/a:free" ? Promise.resolve(new Response("busy", { status: 429 })) : ok('{"answer":"b"}');
    await g.generate(echoTask, "x");
    expect(g.usageToday()).toBe(2);

    clock.advance(24 * 60 * 60_000);
    expect(g.usageToday()).toBe(0);
    expect(gateway().usageToday()).toBe(0);
  });

  it("returns the daily-limit error without calling fetch once the day's requests are used", async () => {
    expect(DAILY_LIMIT).toBe(1000);
    const g = gateway({ models: ["model/a:free"], dailyLimit: 3 });
    for (let i = 0; i < 3; i++) await g.generate(echoTask, String(i));
    expect(g.usageToday()).toBe(3);
    const result = await g.generate(echoTask, "one too many");
    expect(result).toMatchObject({ ok: false, error: { kind: "daily-limit" } });
    expect(sent).toHaveLength(3);
  });

  it("stops at the daily limit part-way through the fallback list", async () => {
    reply = () => Promise.resolve(new Response("busy", { status: 429 }));
    const result = await gateway({ dailyLimit: 2 }).generate(echoTask, "x");
    expect(result).toMatchObject({ ok: false, error: { kind: "daily-limit" } });
    expect(sent).toHaveLength(2);
  });

  it("fails without calling fetch when no API key is set", async () => {
    const result = await gateway({ apiKey: "" }).generate(echoTask, "x");
    expect(result).toMatchObject({ ok: false, error: { kind: "all-models-failed" } });
    expect(sent).toHaveLength(0);
  });
});

describe("OpenRouter embeddings", () => {
  const vectors = (body: Sent["body"]) =>
    Promise.resolve(
      // Out of order on purpose: the gateway puts them back by index.
      Response.json({ data: body.input!.map((t, index) => ({ index, embedding: [t.length, index] })).reverse() }),
    );

  it("embeds every text in one request to the embedding model, in input order", async () => {
    reply = vectors;
    const g = gateway();
    expect(await g.embed(["ab", "abcd", "x"])).toEqual([
      [2, 0],
      [4, 1],
      [1, 2],
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(sent[0]!.body).toMatchObject({
      model: "embed/model:free",
      input: ["ab", "abcd", "x"],
      provider: { data_collection: "deny" },
    });
    expect(g.usageToday()).toBe(1);
  });

  it("sends nothing for no texts", async () => {
    expect(await gateway().embed([])).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("rejects on a failed request, at the daily limit, and without an API key", async () => {
    reply = () => Promise.resolve(new Response("busy", { status: 429 }));
    await expect(gateway().embed(["a"])).rejects.toThrow(/429/);

    reply = vectors;
    const g = gateway({ dailyLimit: 2 }); // the failed request above counted too
    await g.embed(["a"]);
    await expect(g.embed(["b"])).rejects.toThrow(/2 LLM requests/);
    await expect(gateway({ apiKey: "" }).embed(["a"])).rejects.toThrow(/API key/);
    expect(sent).toHaveLength(2);
  });

  it("rejects a reply without one vector per text", async () => {
    reply = () => Promise.resolve(Response.json({ data: [{ index: 0, embedding: [1] }] }));
    await expect(gateway().embed(["a", "b"])).rejects.toThrow(/vector/);
  });
});
