# Homework review and comparison with free models

Research for issue #4 (parent map: #1). Researched 2026-11-23.

**Question.** How can an LLM give a Student a deep review of their homework submission, and compare it with other Students' submissions, using only OpenRouter free models? Constraints: solo developer, one week to ship, live in-class demo with about 30 Students.

**Vocabulary note.** This branch has no `GLOSSARY.md` and no `docs/adr/` yet. The repo holds only `README.md` and `assets/`, and the GitHub repo has no commits. The terms below follow issue #1: *Student*, *Lecturer*, *Session*. *Submission* means one Student's upload for one homework.

**Snapshot warning.** Free-model availability on OpenRouter changes often. OpenRouter itself warns: "Free model availability changes frequently" ([Free Models Router][free-router]). The model tables below come from the live models API on 2026-11-23 ([`/api/v1/models`][models-api], [`/api/v1/embeddings/models`][emb-models-api]). Re-run that query before building.

---

## 1. Budget: the free tier's request limit is the main constraint

| Credits ever purchased on the account | Requests/minute | Requests/day |
| - | - | - |
| Less than 10 | 20 | 50 |
| At least 10 | 20 | 1000 |

Source: [OpenRouter Limits][limits].

- These limits apply to any model whose ID ends in `:free` ([Limits][limits]). The free embedding models also end in `:free` (§4), so they presumably count against the same limit. That is an inference: the docs do not say so explicitly.
- Creating more accounts or keys does not help: "we govern capacity globally" ([Limits][limits]).
- `GET /api/v1/key` returns `free_model_daily_requests.{used,limit,remaining}` for the current UTC day, so the app can show remaining quota and refuse work before a 429. The per-minute limit is not reported there ([Limits][limits]).
- A 429 from a free-model limit carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers ([Limits][limits]).
- If you list a `:free` model in a `models` fallback array, a fallback to a paid model **is billed**. To stay free, list only `:free` models or use `openrouter/free` on its own ([Free variant][free-variant]).

**Consequence for a class of 30.** At 50 requests/day, one review call per Student uses 30 of the 50. That leaves 20 for everything else in the app that day, including video summaries (issue #1). Pairwise LLM comparison needs C(30,2) = 435 calls and is impossible at 50/day; even at 1000/day it would use almost half the daily allowance. Comparison therefore has to run locally or use one batched call. A one-off purchase of 10 credits raises the cap to 1000/day ([Limits][limits]). That is a purchase, not a paid API, but it is the Lecturer-developer's decision.

## 2. Free models available now, and JSON-schema support

Free chat models from the live API (2026-11-23), filtered to those that take text input and return text ([models API][models-api]):

| Model | Context (tokens) | Max output | Input | `structured_outputs` |
| - | - | - | - | - |
| `inclusionai/ling-3.2-flash:free` | 1,048,576 | 262,144 | text, image | yes |
| `particle-ai/particle-1:free` | 1,048,576 | 131,072 | text, image | yes |
| `baidu/ernie-5.5-flash-preview:free` | 1,024,000 | 921,600 | text | yes |
| `nvidia/nemotron-3.5-super-vl:free` | 1,000,000 | 131,072 | text, image, video | yes |
| `nvidia/nemotron-3.5-lightning:free` | 1,000,000 | 65,536 | text | no |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1,000,000 | 65,536 | text | no |
| `dots-studio/dots-3-note-preview:free` | 512,000 | 460,800 | text, image | yes |
| `google/gemma-4-31b-it:free` | 262,144 | 32,768 | text, image, video | no (`response_format` only) |
| `google/gemma-4-26b-a4b-it:free` | 262,144 | 32,768 | text, image, video | no (`response_format` only) |
| `recursive/flint-v1.0:free` | 262,144 | 235,929 | text | no (`response_format` only) |
| `liquid/lfm-3-1.7b:free` | 262,144 | 8,192 | text | yes |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256,000 | 65,536 | text, audio, image, video | no |
| `openrouter/free` (router) | 200,000 | n/a | text, image | yes |

- **Context depends on the endpoint.** For example, the `nemotron-3.5-super-vl:free` endpoint (provider: Nvidia) caps the prompt at 868,928 tokens within its 1M context ([endpoints API][nemotron-endpoints]).
- **Free router.** `openrouter/free` picks a free model at random from those that support the request's features, including structured outputs. You cannot choose which model it picks ([Free Models Router][free-router]). That makes reviews non-reproducible between runs, which is a poor fit for grading.
- **Structured outputs.** Send `response_format: {type: "json_schema", json_schema: {..., strict: true}}` on Chat Completions, or `text.format` on the Responses API. Support is decided "per endpoint, not just per model". Set `provider.require_parameters: true` so OpenRouter only routes to endpoints that support it. Even with `strict: true`, "exact compliance is not guaranteed on every endpoint" ([Structured Outputs][structured]).
- **Repairing JSON.** The `response-healing` plugin repairs malformed JSON: missing brackets, trailing commas, JSON wrapped in markdown fences, text mixed with JSON. It runs on non-streaming requests that use `json_schema` or `json_object` ([Response Healing][healing]). Still validate on the client, for example with a zod schema.

## 3. Rubric-based review: prompting and output shape

**What the research says about reliability**

- In a study using Qwen 2.5-72B on SciEntsBank, LLM grading agreed strongly with experts on binary rubric items, but "degrades with increased rubric granularity". Filtering out low-confidence predictions improved accuracy on the rest. The model resisted prompt injection but was "sensitive to synonym substitutions" ([Rubric-Conditioned LLM Grading, arXiv:2601.08843][rubric-paper]).
- LLM judges show position, verbosity and self-enhancement biases. Strong judges reached over 80% agreement with human preferences ([Zheng et al., arXiv:2306.05685][llm-judge]). Position bias in pairwise and list-wise judging "is not due to random chance and varies significantly across judges and tasks" ([Judging the Judges, arXiv:2406.07791][position-bias]).

**Design that follows from this**

- **Coarse rubric.** Use 3–5 criteria, each with 3 levels (e.g. *missing / partial / meets*), rather than 0–10 scores. Finer scales degrade alignment ([arXiv:2601.08843][rubric-paper]).
- **One criterion at a time, evidence before verdict.** For each criterion, the model quotes the relevant part of the submission, then justifies, then picks a level. A `confidence` field lets the UI flag low-confidence items for the Lecturer. That follows the deferral result in [arXiv:2601.08843][rubric-paper].
- **Treat submission text as data.** Wrap it in delimiters and tell the model to ignore any instructions inside it. Students can embed prompt-injection text; the paper above tested that case.
- **Lecturer in the loop.** The Lecturer writes the rubric, or edits one the LLM drafts from the brief, and releases each review. A review is feedback, not a grade.

**Example schema** (Chat Completions `response_format.json_schema.schema`):

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["criteria", "overall_summary", "next_steps"],
  "properties": {
    "criteria": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["criterion_id", "evidence", "reasoning", "level", "confidence", "suggestion"],
        "properties": {
          "criterion_id": { "type": "string", "description": "id from the rubric" },
          "evidence":     { "type": "string", "description": "short quote or line ref from the submission" },
          "reasoning":    { "type": "string" },
          "level":        { "type": "string", "enum": ["missing", "partial", "meets"] },
          "confidence":   { "type": "string", "enum": ["low", "medium", "high"] },
          "suggestion":   { "type": "string", "description": "one concrete improvement" }
        }
      }
    },
    "overall_summary": { "type": "string" },
    "next_steps": { "type": "array", "items": { "type": "string" }, "maxItems": 3 }
  }
}
```

Request settings: `model` set to a pinned free model that has `structured_outputs` (§2), with `models` listing only other `:free` structured-output models as fallbacks ([Free variant][free-variant]); `provider: {require_parameters: true, data_collection: "deny"}` (see §6); `plugins: [{id: "response-healing"}]`; low temperature.

## 4. Similarity and plagiarism signals

Three families of approach, compared for 30 submissions:

| Approach | Catches | Cost per class of 30 | Notes |
| - | - | - | - |
| **Fingerprinting** (k-gram shingles plus winnowing, as in MOSS) | Copied or lightly edited passages; code with renamed variables, if tokens are normalised | 0 API requests, milliseconds | Gives the matching passages as evidence. Deterministic. |
| **Embeddings + cosine similarity** | Paraphrase and semantic overlap | 1 batched request (OpenRouter `:free`) or 0 (in the browser) | Everyone answers the same question, so the baseline similarity is high (inference). Flag outliers relative to the class, not by an absolute threshold. |
| **LLM pairwise judging** | Similarity of argument or structure, with an explanation | 435 requests | Too many requests for the free tier (§1), and pairwise judging has position bias ([arXiv:2406.07791][position-bias]). Use it only to *explain* a few pairs already flagged. |

**Fingerprinting (winnowing).**

- Winnowing hashes every k-gram and keeps the minimum hash in each window of `w` hashes. It has two guarantees: any shared substring at least `t = w + k − 1` long is detected, and nothing shorter than the noise threshold `k` is reported ([Schleimer, Wilkerson & Aiken, SIGMOD 2003][winnowing]).
- Its density is about 2/(w+1), within 33% of the lower bound for local algorithms ([winnowing][winnowing]).
- Normalise before hashing: strip whitespace and punctuation, lowercase, and for code replace identifiers with a placeholder such as "V" ([winnowing][winnowing]).
- The author notes that Figure 5 of the paper has bugs ([author's page][winnowing-page]). Some applications of the algorithm are patented by the Regents of the University of California ([author's page][winnowing-page]).
- **MOSS as a hosted service.**
  - Anyone can get a free account by email, for non-commercial use only. Submissions are capped at 100/day/user ([MOSS][moss]).
  - Results "will be accessible to anyone with the result URL" ([MOSS][moss]).
  - It supports code only (C, Java, Python, JavaScript and others) and can exclude instructor-supplied code ([MOSS][moss]).
  - Depending on registration by email and an external server is a risk for a one-week build and a live demo. A small in-app winnowing implementation avoids both.
- **Caveat from MOSS itself.** "It is a misuse of Moss to rely solely on the similarity scores… the scores are certainly not a proof of plagiarism. Someone must still look at the code" ([MOSS][moss]).
- **Limits.** Code written by an LLM (GPT-J) passed MOSS without raising suspicion ([arXiv:2201.07406][fool-moss]). Advanced, behaviour-preserving obfuscation defeats plagiarism detectors ([arXiv:2505.20158][obfuscation]). Similarity tools say nothing reliable about AI use. Don't claim they do.

**Embeddings, option A: OpenRouter free models.** Three free embedding models are listed ([embeddings models API][emb-models-api]):

| Model | Context | Input |
| - | - | - |
| `nvidia/nemotron-3.5-embed-1b:free` | 32,768 | text, image |
| `nvidia/nemotron-3.5-embed-8b:free` | 32,768 | text, image |
| `nvidia/nemotron-3-embed-1b:free` | 4,096 | text |

`POST /api/v1/embeddings` accepts an array of strings, so all 30 submissions can be embedded in one request ([Embeddings API][embeddings]). OpenRouter's docs list "Duplicate Detection… even when text is paraphrased" as a use case ([Embeddings API][embeddings]).

**Embeddings, option B: in the browser with Transformers.js.** Transformers.js runs models in the browser via ONNX Runtime. It uses WASM on the CPU by default, or `device: 'webgpu'` ([Transformers.js docs][tfjs]).

- `Xenova/all-MiniLM-L6-v2` produces 384-dimensional vectors. Its int8 ONNX file is 23.0 MB ([HF files][minilm-files]).
- It truncates input longer than 256 word pieces ([model card][minilm-card]), so submissions must be chunked and their vectors averaged.
- Cost: no API quota, but a 23 MB download on Students' phones. If used, run it on the Lecturer's device only.

## 5. Context window: one big call vs many small ones

- **Fits in one call.** Every structured-output model in §2 with a context of 512k or more could hold all 30 submissions in one prompt. For example, 30 × 3k tokens ≈ 90k tokens (illustrative arithmetic).
- **But long contexts are used unevenly.** Models do best when the relevant information is at the start or end of the context, and "significantly degrade" when it is in the middle, "even for explicitly long-context models" ([Lost in the Middle, arXiv:2307.03172][lost-middle]). One giant "compare everyone" prompt would therefore miss pairs in the middle, and its results would depend on submission order.
- **Pattern that fits the budget.**
  1. One review call per submission (rubric only, no classmates' work).
  2. Local fingerprinting plus one batched embeddings call for the whole class.
  3. At most one *class-summary* call, run only after reviews finish. Feed it the 30 structured reviews (small JSON), not the raw submissions. It produces common strengths and mistakes across the class.
  4. Optionally, one LLM call per flagged pair to explain the overlap, for the Lecturer only.

  Total for 30 Students: about 30 + 1 + 1 + a few ≈ 35 requests, inside the 50/day tier.

## 6. Submission formats

| Format | Approach | Source |
| - | - | - |
| Plain text / Markdown | Send as text. | n/a |
| Code (single files) | Send as text with filename and line numbers so the model can cite lines. Normalise tokens for fingerprinting. | [winnowing][winnowing] |
| PDF with a text layer | Extract text yourself (`pdfjs-dist` 6.5.x, or `unpdf` 2.2.x, "PDF extraction… across all JavaScript runtimes") ([npm: pdfjs-dist][pdfjs-npm], [npm: unpdf][unpdf-npm]). Or let OpenRouter parse it with `plugins: [{id: "file-parser", pdf: {engine: "cloudflare-ai"}}]`, which is free. | [PDF Inputs][pdfs] |
| Scanned PDF / photo of handwriting | Render the pages to images and send them to a free vision model (`nemotron-3.5-super-vl:free`, `gemma-4-*:free`). | [models API][models-api] |

**PDF billing risk.** If no PDF engine is specified and the model cannot read files natively, OpenRouter falls back to `mistral-ocr`. That engine costs $2 per 1,000 pages, and "OCR costs apply to all requests" ([PDF Inputs][pdfs]). Always pin `engine: "cloudflare-ai"`, or extract the text yourself. Extracting it yourself is better, because fingerprinting needs the text anyway.

## 7. Privacy and what a Student may see about classmates

**Sending Student work to free models**

- OpenRouter does not store prompts or responses unless you opt in. Exceptions: CSAM screening, and providers with a *Safety Retention* policy ([Data Collection][data-collection]).
- Providers have their own policies, and some may train on prompts. The account has "separate settings for paid and free models" to block providers that train ([Provider Logging][provider-logging]).
- Per request, `provider.data_collection: "deny"` restricts routing to "providers which do not collect user data" ([Provider selection][provider-selection]).
- **Open point.** The endpoint metadata I queried does not show each free endpoint's data policy ([endpoints API][nemotron-endpoints]). So I could not confirm which free models stay available under `deny`. Test this on the real key before the demo.
- **UK schools guidance.** The DfE's *Generative AI product safety standards* (updated 19 January 2026) say products "must not store, collect or use intellectual property created by learners… for any commercial purposes, such as training or fine tuning of models, unless consented to" by the copyright owner ([DfE][dfe]). The audience here is a university, so this is guidance by analogy, not a binding rule.
- **Pseudonymise before sending.** Send a submission ID, never a name or student number, so the provider sees no identity. Pseudonymised data is still personal data for the app ([ICO glossary][ico-glossary]).

**What a Student sees about others**

- Aggregates are not automatically anonymous. The ICO describes identifiability as a spectrum. It defines aggregated data as statistics "without identifying people within the data", and lists cell suppression as a technique ([ICO anonymisation glossary][ico-glossary], [ICO: ensuring anonymisation is effective][ico-effective]). The ICO marks this guidance as under review after the Data (Use and Access) Act 2025 ([ICO glossary][ico-glossary]).
- **Recommended policy** (my synthesis from the sources above; no source sets these exact rules):
  - **Student sees:** their own review; per-criterion class distributions (counts of *missing / partial / meets*); the class-summary's common strengths and mistakes, written without quoting any submission.
  - **Suppress any distribution with fewer than 5 submissions.** In a small class, "1 Student got *missing*" can identify someone.
  - **Student never sees:** classmates' names next to scores, classmates' text, rankings, or similarity flags involving them.
  - **Similarity flags go to the Lecturer only,** shown as "passages worth a look" with the matched spans. MOSS's guidance is that a human must judge, and scores are not proof ([MOSS][moss]).
- **US contrast (FERPA).** A grade a student writes on a classmate's paper is not an "education record" until the teacher records it ([Owasso v. Falvo, 534 U.S. 426][owasso]). That case does not authorise showing named comparisons, and the policy above does not rely on it.

---

## Recommendation

1. **Review.** One structured-output call per submission to a pinned free model that supports `structured_outputs`. Today that means `nvidia/nemotron-3.5-super-vl:free` (also reads page images) or `inclusionai/ling-3.2-flash:free`. Use a coarse rubric (3–5 criteria × 3 levels) and evidence before each verdict. Set `require_parameters: true`, `data_collection: "deny"`, the `response-healing` plugin, a `models` fallback list of `:free` models only, and validate with zod. Show the review to the Student only after the Lecturer releases it.
2. **Compare.** Not with an LLM. Run winnowing fingerprints in-app (normalise identifiers for code) and make one batched call to `nvidia/nemotron-3.5-embed-1b:free`. Flag pairs that stand out from the class distribution to the Lecturer only, with the matched passages. Optionally make one LLM call per flagged pair to explain it. Skip MOSS: registration by email, an external dependency and public result URLs.
3. **Class insight for Students.** One class-summary call over the 30 structured reviews, not the raw submissions. Show anonymised per-criterion counts, suppressed when fewer than 5 submissions, plus common strengths and mistakes. Never show names, rankings or classmates' text.
4. **Formats.** Text and code as-is. PDFs: extract the text in-app with `unpdf` or pdf.js, falling back to OpenRouter `file-parser` pinned to `cloudflare-ai`, never the default OCR, which is billed. Scanned pages go to the vision model. That's a stretch goal for the demo.
5. **Budget.** About 35 requests per class, inside 50/day. Show `free_model_daily_requests.remaining` to the Lecturer and refuse work before hitting a 429. Ask the Lecturer-developer whether to buy 10 credits for the 1000/day tier as insurance for the live demo. Re-check the free model list the day before.

<!-- Sources -->
[limits]: https://openrouter.ai/docs/api-reference/limits.md
[free-variant]: https://openrouter.ai/docs/guides/routing/model-variants/free.md
[free-router]: https://openrouter.ai/docs/guides/routing/routers/free-router.md
[structured]: https://openrouter.ai/docs/guides/features/structured-outputs.md
[healing]: https://openrouter.ai/docs/guides/features/plugins/response-healing
[pdfs]: https://openrouter.ai/docs/guides/overview/multimodal/pdfs.md
[embeddings]: https://openrouter.ai/docs/api_reference/embeddings
[data-collection]: https://openrouter.ai/docs/guides/privacy/data-collection
[provider-logging]: https://openrouter.ai/docs/guides/privacy/provider-logging
[provider-selection]: https://openrouter.ai/docs/guides/routing/provider-selection
[models-api]: https://openrouter.ai/api/v1/models
[emb-models-api]: https://openrouter.ai/api/v1/embeddings/models
[nemotron-endpoints]: https://openrouter.ai/api/v1/models/nvidia/nemotron-3.5-super-vl:free/endpoints
[rubric-paper]: https://arxiv.org/abs/2601.08843
[llm-judge]: https://arxiv.org/abs/2306.05685
[position-bias]: https://arxiv.org/abs/2406.07791
[lost-middle]: https://arxiv.org/abs/2307.03172
[winnowing]: https://sschleimer.warwick.ac.uk/Maths/winnowing.pdf
[winnowing-page]: https://sschleimer.warwick.ac.uk/Maths/winnowing.html
[moss]: https://theory.stanford.edu/~aiken/moss/
[fool-moss]: https://arxiv.org/abs/2201.07406
[obfuscation]: https://arxiv.org/abs/2505.20158
[tfjs]: https://huggingface.co/docs/transformers.js/en/index
[minilm-files]: https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/main/onnx
[minilm-card]: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
[pdfjs-npm]: https://www.npmjs.com/package/pdfjs-dist
[unpdf-npm]: https://www.npmjs.com/package/unpdf
[dfe]: https://www.gov.uk/government/publications/generative-ai-product-safety-standards/generative-ai-product-safety-standards
[ico-glossary]: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-sharing/anonymisation/glossary/
[ico-effective]: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-sharing/anonymisation/how-do-we-ensure-anonymisation-is-effective/
[owasso]: https://www.law.cornell.edu/supremecourt/text/534/426
