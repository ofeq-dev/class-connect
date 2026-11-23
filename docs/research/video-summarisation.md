# Research: video summarisation with free speech-to-text and OpenRouter

Ticket: [#2](https://github.com/ofeq-dev/class-connect/issues/2) (parent map [#1](https://github.com/ofeq-dev/class-connect/issues/1)).
Researched 2026-11-23. Every number below comes from the cited page or API response as of that date. Free tiers and the free-model catalogue change often, so re-check them before demo day.

**Question.** How do we turn a ~90-minute lecture recording (an export from Zoom, Meet or Classroom) into a summary using only free tooling? The LLM must be an OpenRouter free model. We need to choose a transcription route, and to know the file sizes, processing times, rate limits and how to chunk the transcript. Constraints: solo developer, ship in one week, live demo in class.

---

## 1. Skip transcription when the platform already made a transcript

| Source | Transcript? | Format | Conditions |
|---|---|---|---|
| **Zoom cloud recording** | Yes | **VTT**, shown "as a separate VTT file in the list of recorded meetings" [Z2] | Needs a Pro, Business, Education or Enterprise account with cloud recording on [Z1]. An admin must turn on *Create audio transcript*. It can't be switched on or off during a meeting [Z1]. Zoom gives no processing time: "the audio transcript may take additional time to process" [Z2]. |
| **Zoom local (computer) recording** | No | — | "Audio transcription applies only to cloud recordings. It does not apply to computer recordings" [Z1]. Local recording does produce `audioN.m4a`, an audio-only file, next to `videoN.mp4` [Z4]. A separate setting can save *closed captions* as VTT [Z5], but only if captions were running. |
| **Zoom cloud audio-only** | — | **M4A** | The "Record audio-only files" option produces M4A [Z3]. |
| **Google Meet** | Yes | A **Google Doc** saved to the organiser's Drive [G1][G2] | Needs Business Standard or Plus, Enterprise Starter, Standard or Plus, *Teaching and Learning Upgrade*, *Education Plus*, or Workspace Individual [G1]. It must be started during the meeting (or set to start automatically) [G1]. Languages: English, French, German, Italian, Japanese, Korean, Portuguese and Spanish [G1]. |
| **Google Classroom** | No separate export | — | Classroom meetings are Meet meetings. On *Education Fundamentals / Standard*, "teachers, staff or students can't record meetings they organize" [G3]. |

**What this means for us.** If the Lecturer's institution has paid Zoom or a Workspace Education Plus / Teaching and Learning tier, a transcript may already exist. Accepting a **`.vtt` or `.txt` upload** removes speech-to-text from the critical path. VTT is plain text with timestamps, so it is trivial to parse. A Google Doc can be downloaded as `.txt`. Many free and student accounts won't have transcripts, though, so we still need an audio route.

## 2. Transcription options

### 2a. OpenRouter itself (the ticket's premise is out of date)

OpenRouter **now has speech-to-text**. It has an STT endpoint (`stt.createTranscription`, e.g. `openai/whisper-large-v3`) [O5], and the Responses and Chat APIs accept `input_audio` [O4]. **None of the 30 transcription models in the catalogue has a free price.** Every `audio->transcription` model returned by `/api/v1/models?output_modalities=transcription` has a non-zero price, for example `openai/whisper-large-v3-turbo` and `nvidia/nemotron-3.5-transcribe` [O2]. So OpenRouter STT breaks the "free" constraint.

There is one edge case. `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` is free and lists `audio` among its input modalities (256k context) [O2]. The audio has to be base64 inside the JSON body. The Responses API accepts only `wav`/`mp3`, while Chat Completions passes other formats through [O4]. Nothing documents how many tokens 90 minutes of audio costs on this model, or what request-size ceiling applies. **I have not verified that it works on a full lecture.** Treat it as a curiosity, not the plan.

### 2b. Groq Whisper, free tier (hosted)

- Models are `whisper-large-v3-turbo` (12% WER, real-time speed factor **216**) and `whisper-large-v3` (10.3% WER, factor 189) [Q1].
- **Max file size: 25 MB on the free tier** (100 MB on the paid dev tier). Passing a `url` instead of uploading avoids the 25 MB *attachment* limit, but the free-tier file cap still applies [Q1]. Accepted inputs are `flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm`. Only the first audio track is used [Q1].
- Groq resamples everything to **16 kHz mono**, so doing that on the client loses nothing [Q1]. `verbose_json` returns segment and word timestamps [Q1].
- **Rate limits.** The public table lists `20 RPM, 2K RPD, 7.2K audio-seconds/hour (ASH), 28.8K audio-seconds/day (ASD)` for both Whisper models. The page labels that table "the base limits for the Developer plan" and says the exact limits for *your* organisation are on the logged-in Limits page [Q2]. A Free tier does exist; you can downgrade back to it and it has its own "Free tier rate limits" [Q3]. **Open item:** check the free numbers at console.groq.com/settings/limits. At the published values, one 90-minute lecture (5,400 audio-seconds) fits within an hour's budget, and about five fit per day.
- **Time:** at a speed factor of 216, 90 minutes of audio is about **25 s of compute**. Upload time comes on top of that.
- Groq's docs recommend chunking larger files with overlap and point to a cookbook [Q1].

### 2c. Cloudflare Workers AI Whisper (hosted, free allocation)

- The free allocation is **10,000 Neurons per day** on both Workers Free and Workers Paid [C1]. `@cf/openai/whisper-large-v3-turbo` costs **46.63 neurons per audio minute** [C1]. That gives roughly 214 audio-minutes per day, about two lectures.
- The ASR rate limit is 720 requests/minute [C2]. Built-in options include `vad_filter`, `initial_prompt` and hallucination thresholds [C3].
- This is a reasonable **backup** to Groq. It needs a Cloudflare account and a Worker.

### 2d. In-browser Whisper (transformers.js or whisper.cpp WASM)

- **whisper.cpp WASM:** its own README says "the performance is not great". It reaches about **2–3× real time** for `tiny`/`base` on a modern desktop CPU, supports models only "up to size `small`", and the example caps audio at **120 seconds** [W1]. At that speed, 90 minutes takes **30–45 minutes** on a laptop, and the 120 s cap means we would have to write our own chunking.
- **transformers.js:** runs on CPU (WASM) by default. `device: 'webgpu'` is opt-in and "still experimental in many browsers" [T1]. The v3 release claims WebGPU is "up to 100x faster than WASM" and ships a Whisper WebGPU demo [T2]. No first-party benchmark covers 90-minute files.
- **Download size per device:**

  | Model (ONNX) | Encoder | Decoder (merged) | Total |
  |---|---|---|---|
  | whisper-base, `quantized` | 23.2 MB | 53.7 MB | ~77 MB [T3] |
  | whisper-large-v3-turbo, `q4f16` | 370.0 MB | 193.5 MB | ~564 MB [T4] |

  For comparison, whisper.cpp ggml models need `base` 142 MiB on disk / ~388 MB RAM, and `large` 2.9 GiB / ~3.9 GB [W2].
- **WebGPU availability:** Chrome on Android since 121. Safari since 26 (iOS mirrors desktop Safari). Firefox on Android has **no support**. Firefox desktop support is partial [B1].
- **Verdict:** this is too slow on CPU and too large to download on phones. We can't predict which machine the demo will run on, so it is not a good fit for a one-week build. Its only real advantage is privacy, because the audio never leaves the device.

### 2e. Local or server-side Whisper (whisper.cpp `whisper-server`)

whisper.cpp ships an HTTP server with an OpenAI-like API [W2]. It needs an always-on host with enough RAM (table above). Free serverless hosts can't run it. It is fine for development on a laptop, but it adds a hosting problem we don't otherwise have.

## 3. File sizes and getting audio to the API

90 min = 5,400 s. I computed these from bitrates and then checked them with `ffmpeg` on a synthetic 90-minute mono signal:

| Encoding | Arithmetic | Measured | Fits Groq free (25 MB)? |
|---|---|---|---|
| WAV, 16 kHz mono, 16-bit | 172.8 MB | 172.8 MB | No |
| MP3 mono 32 kbit/s | 21.6 MB | 21.6 MB | Just |
| **Opus (OGG) mono 20 kbit/s** | 13.5 MB | 10.6 MB (VBR, synthetic signal) | **Yes, with headroom** |

16–20 kbit/s is Opus's own "sweet spot" for wideband (16 kHz) speech [R1]. That matches what Whisper uses anyway [Q1].

- **Body-size trap.** Serverless functions often limit request bodies. Vercel, for example, caps them at **4.5 MB** by default, with 20 MiB in beta for Node [V1]. A 13 MB audio file can't be proxied through such a function in one request. Either split the audio into segments under ~4 MB (about 25 minutes each at 20 kbit/s), or upload to blob storage and pass Groq a `url` [Q1].
- **Transcoding in the browser:** `ffmpeg.wasm` can do the transcode and split in one command. Costs: a ~32 MB core `.wasm` download [F2], a **2 GB hard input limit**, and running "a lot slower than native" [F1]. Do this from the Lecturer's laptop, not a phone. Zoom's audio-only `.m4a` avoids pushing a large video through it.

## 4. Fitting the transcript into a free model's context

**How long is a transcript?** British-English speech, lectures included, runs at roughly **130–220 words/minute** [S1]. One token is about ¾ of a word [S2]. 90 min × 130–220 wpm comes to 11,700–19,800 words, which is about **16k–26k tokens**.

**Current OpenRouter free text models with large context** (from `GET /api/v1/models`, where `:free` means price 0 [O2][O6]):

| Model | Context | Max output | Notes |
|---|---|---|---|
| `inclusionai/ling-3.2-flash:free` | 1,048,576 | 262,144 | hybrid reasoning |
| `baidu/ernie-5.5-flash-preview:free` | 1,024,000 | 921,600 | preview |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1,000,000 | 65,536 | large MoE reasoning |
| `nvidia/nemotron-3.5-super-vl:free` | 1,000,000 | 131,072 | |
| `nvidia/nemotron-3.5-lightning:free` | 1,000,000 | 65,536 | small, fast |
| `dots-studio/dots-3-note-preview:free` | 512,000 | 460,800 | preview |
| `google/gemma-4-31b-it:free` | 262,144 | 32,768 | served by Google AI Studio [O3] |
| `google/gemma-4-26b-a4b-it:free` | 262,144 | 32,768 | |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256,000 | 65,536 | takes audio (§2a) |
| `liquid/lfm-3-1.7b:free` | 262,144 | 8,192 | 1.7B; "prompts and outputs may be retained" [O2] |
| `openrouter/free` | 200,000 | — | router that picks a random free model [O7] |

(`particle-1` and `flint` are free too but tuned for coding [O2].) Most of these were added in the last six months [O2], so expect churn.

**Free-model rate limits** [O1]: **20 requests/minute** on every account. Requests/day: **50** if you have bought fewer than 10 credits, **1,000** if you have bought at least 10. Upstream providers can also return 429s, and OpenRouter retries other providers for the same model. `GET /api/v1/key` reports `free_model_daily_requests` [O1]. A negative balance can block free models too [O1]. The `models` array falls back to the next model on error [O8].

**Privacy:** OpenRouter itself doesn't store prompts unless you opt in [O9]. Whether *providers* may train on prompts is a separate account setting, with its own switch for free models [O10]. That is acceptable for a demo, but worth one line in the SRS.

**Chunking strategy.**

1. **Single pass ("stuff") by default.** A 16–26k-token transcript is under 15% of the smallest context listed above, so one request does the whole summary. That matters when the budget is 50 requests per day.
2. **Long inputs still lose detail.** Models use information in the middle of long contexts worse than information at the start or end [S3]. Mitigations: ask for a structured output (sections plus `[mm:ss]` timestamps), and keep timestamps in the transcript as anchors.
3. **Map-reduce only above a threshold**, e.g. more than 100k tokens or a model whose context is smaller. Split the transcript into chunks on segment or cue boundaries, summarise each chunk (map), then summarise the summaries (reduce) [S4]. Run the map calls one after another, or at most a few at a time, to stay under 20 RPM. A 90-minute lecture never needs this.

## 5. End-to-end time for one 90-minute lecture

| Step | Time |
|---|---|
| Transcode with ffmpeg.wasm on a laptop | Not measured. WASM is "a lot slower than native" [F1]. Budget minutes, not seconds, and measure on day 1. |
| Upload ~13 MB | Depends on network. Seconds on campus Wi-Fi. |
| Groq turbo transcription | ~25 s of compute [Q1] |
| One OpenRouter free summary call | Depends on the model and on whether a free provider has capacity. Reasoning models take longer. Not benchmarked here. |
| **Skip all of the above with a Zoom VTT or Meet transcript** | **Parse plus one LLM call** |

---

## Recommendation

1. **Two inputs, one pipeline.** The Lecturer uploads *either* a transcript (`.vtt`/`.txt`, the Zoom or Meet export) *or* an audio/video file. Both become a timestamped plain-text transcript, which feeds a single summary step.
2. **Speech-to-text: Groq `whisper-large-v3-turbo` free tier.** In the browser, `ffmpeg.wasm` makes 16 kHz mono Opus at 20 kbit/s and splits it into ~20-minute segments (each under 4 MB). The server proxies each segment to Groq so the key stays server-side, then joins the text with time offsets. The Lecturer-developer needs a free Groq key. On day 1, confirm the free-tier audio-seconds limit on the Groq Limits page. **Backup:** Cloudflare Workers AI Whisper (~214 free minutes per day).
3. **Don't build** in-browser Whisper, a self-hosted Whisper server, OpenRouter's paid STT, or Nemotron Omni audio input this week.
4. **Summary: one single-pass call to an OpenRouter free model** with a `models` fallback list, e.g. `google/gemma-4-31b-it:free` → `nvidia/nemotron-3-ultra-550b-a55b:free` → `openrouter/free`. Pick the primary after a 10-minute side-by-side on one real transcript. Ask for structured output with `[mm:ss]` anchors. Implement map-reduce only behind a token threshold (>100k), which a 90-minute lecture never reaches.
5. **Protect the live demo.** The 50/day free cap and upstream 429s make a cold run risky. Pre-compute and store the summary of the real lecture before class. Run a short (~5-minute) clip end-to-end live, and show the stored 90-minute result. Buying 10 OpenRouter credits once would raise the cap to 1,000/day. That is the Lecturer-developer's call, since the brief says "free".

---

## Sources

**OpenRouter**
- [O1] Credit Limits and Rate Limits: https://openrouter.ai/docs/api-reference/limits.md
- [O2] Models API, fetched 2026-11-23: https://openrouter.ai/api/v1/models (and `?output_modalities=transcription`, `?output_modalities=all`)
- [O3] Endpoints API, e.g. https://openrouter.ai/api/v1/models/google/gemma-4-31b-it:free/endpoints
- [O4] Audio guide: https://openrouter.ai/docs/guides/overview/multimodal/audio.md
- [O5] STT SDK reference: https://openrouter.ai/docs/client-sdks/typescript/sdks/stt/README.md
- [O6] Free variant: https://openrouter.ai/docs/guides/routing/model-variants/free.md
- [O7] Free Models Router: https://openrouter.ai/docs/guides/routing/routers/free-router.md
- [O8] Model Fallbacks: https://openrouter.ai/docs/guides/routing/model-fallbacks.md
- [O9] Data Collection: https://openrouter.ai/docs/guides/privacy/data-collection.md
- [O10] Provider Logging: https://openrouter.ai/docs/guides/privacy/provider-logging.md

**Groq**
- [Q1] Speech to Text: https://console.groq.com/docs/speech-to-text
- [Q2] Rate Limits: https://console.groq.com/docs/rate-limits
- [Q3] Billing FAQs (Free and Developer tiers): https://console.groq.com/docs/billing-faqs

**Cloudflare**
- [C1] Workers AI pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- [C2] Workers AI limits: https://developers.cloudflare.com/workers-ai/platform/limits/
- [C3] whisper-large-v3-turbo model page: https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/

**Zoom**
- [Z1] Enabling or disabling audio transcription for cloud recordings (KB0065911): https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065911
- [Z2] Using audio transcription for cloud recordings (KB0064927): https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0064927
- [Z3] Cloud recording settings (KB0064676): https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0064676
- [Z4] Starting a computer recording (KB0076922): https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0076922
- [Z5] Computer recording settings (KB0063640): https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063640

**Google**
- [G1] Use Transcripts with Google Meet: https://support.google.com/meet/answer/12849897
- [G2] Workspace Updates, "Transcribe speech during Google Meet calls into a Google Doc" (2022-10-11): https://workspaceupdates.googleblog.com/2022/10/google-meet-transcripts.html
- [G3] Record a video meeting: https://support.google.com/meet/answer/9308681

**In-browser and local Whisper**
- [W1] whisper.cpp `whisper.wasm` README: https://github.com/ggml-org/whisper.cpp/blob/master/examples/whisper.wasm/README.md
- [W2] whisper.cpp README (memory table, `whisper-server`): https://github.com/ggml-org/whisper.cpp/blob/master/README.md
- [T1] transformers.js README: https://github.com/huggingface/transformers.js/blob/main/README.md
- [T2] Transformers.js v3 release post: https://huggingface.co/blog/transformersjs-v3
- [T3] `onnx-community/whisper-base` files: https://huggingface.co/onnx-community/whisper-base/tree/main/onnx
- [T4] `onnx-community/whisper-large-v3-turbo` files: https://huggingface.co/onnx-community/whisper-large-v3-turbo/tree/main/onnx
- [B1] MDN browser-compat-data, `api.GPU`: https://github.com/mdn/browser-compat-data/blob/main/api/GPU.json

**Audio and hosting**
- [F1] ffmpeg.wasm FAQ: https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/apps/website/docs/faq.md
- [F2] `@ffmpeg/core@0.12.10` `ffmpeg-core.wasm` (32,232,419 bytes): https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm
- [R1] RFC 6716 (Opus) §2.1.1, bitrate sweet spots: https://www.rfc-editor.org/rfc/rfc6716#section-2.1.1
- [V1] Vercel Functions limitations, request body size: https://vercel.com/docs/functions/limitations

**Transcript length and summarisation**
- [S1] Tauroza & Allison (1990), "Speech Rates in British English", *Applied Linguistics* 11(1):90–105, https://doi.org/10.1093/applin/11.1.90
- [S2] OpenAI Help, "What are tokens and how to count them": https://help.openai.com/en/articles/4936856-what-are-tokens-and-how-to-count-them
- [S3] Liu et al. (2023), "Lost in the Middle: How Language Models Use Long Contexts", TACL 2024: https://arxiv.org/abs/2307.03172
- [S4] LangChain, "How to summarize text through parallelization" (map-reduce): https://python.langchain.com/docs/how_to/summarize_map_reduce
