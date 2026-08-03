# Bulk AI Generator

Bulk **image** and **video** generation through the **kie.ai** API — any of its 40
image models plus Veo 3.1 Lite and Grok Image-to-Video, with multi-account key
support, a character-reference library, a style bible for cross-batch
consistency, and a credit estimate learned from what kie actually bills.

Everything runs locally: your own Next.js server plus the browser. No database, no
cloud storage. Images live in memory and in the browser's IndexedDB; nothing leaves
the machine except the calls to kie.ai.

## Setup

```bash
npm install
cp kie-accounts.example.json kie-accounts.json
```

Fill in `kie-accounts.json` — it's gitignored because it holds real keys:

```json
[
  { "id": "main", "label": "kie.ai — main", "apiKey": "…" }
]
```

Get the key from <https://kie.ai/api-key>. Add more entries to spread a run across
several kie.ai accounts; the account picker switches between them and shows each
one's live credit balance. If you'd rather not keep a file, `KIE_API_KEY` in
`.env.local` works as a fallback.

```bash
npm run dev     # http://localhost:3000
```

## Sharing it with another machine

**On your own network**, nothing needs deploying — `next dev` and `next start`
both bind `0.0.0.0`, so another computer can just open
`http://<your-lan-ip>:3000`. `allowedDevOrigins` in `next.config.ts` is what
lets the dev server's HMR socket and `/_next` internals load from a LAN address;
`next start` doesn't need it. Note the gallery lives in each browser's
IndexedDB, so the other machine starts empty and keeps its own state — only the
kie.ai access is shared.

**Without leaving a machine on**, deploy to Vercel:

```bash
git remote add origin git@github.com:<you>/bulk-image-generator.git
git push -u origin main
```

Import the repo at <https://vercel.com/new> and set two environment variables:

| Variable | Value |
| --- | --- |
| `KIE_API_KEY` | your key from <https://kie.ai/api-key> |
| `APP_PASSWORD` | any password — this is the only thing between the internet and your credits |

`kie-accounts.json` is gitignored and won't be there, so the deployed copy runs
on the single `KIE_API_KEY` account; the picker shows one entry labelled
`KIE_API_KEY (env)`. Multi-account needs the config file, i.e. a machine you
control.

`src/proxy.ts` gates every route, API included, behind HTTP Basic auth against
`APP_PASSWORD` — the browser prompts once and replays the credentials, so there
is no session to manage. It's inert locally (unset password in development
passes through) and **fails closed in production**: a deployment with no
`APP_PASSWORD` serves 503 rather than an open wallet.

Two things to know about serverless hosting:

- **Big images may not fit the response.** Vercel caps a buffered function
  response at 4.5MB, and `/api/kie/generate` returns the image base64-encoded,
  which inflates it by a third. 1K and 2K output is comfortably under; a 4K PNG
  can exceed it and will fail on the host while working fine locally. Video is
  unaffected — `/api/kie/video/file` streams, and streamed responses aren't
  capped.
- **`maxDuration = 300`** on the generate route is at the ceiling of Vercel's
  Hobby plan. If a build warns the value exceeds your plan's limit, lower it and
  lower `POLL_DEADLINE_MS` in `src/server/kie.ts` to match.

## How it works

kie.ai generation is **asynchronous** — `createTask` returns a `taskId`, and the
result arrives later via callback or polling. A callback needs a public URL, which
a localhost app doesn't have, so `POST /api/kie/generate` creates the task, polls
`recordInfo` until it settles, downloads the resulting image and returns the bytes.
From the queue's point of view one job is still one request that either produces an
image or an error.

| Piece | Location |
| --- | --- |
| Model catalog, generated from kie's OpenAPI specs | `src/lib/kieCatalog.ts` |
| Catalog helpers (defaults, reconciliation, limits) | `src/lib/kieModels.ts` |
| kie.ai client — tasks, polling, uploads, errors | `src/server/kie.ts` |
| Account config reader (server-only) | `src/server/accounts.ts` |
| `GET /api/accounts` — returns `{id,label,keyHint}` only | `src/app/api/accounts/route.ts` |
| `GET /api/accounts/credits` — live balance | `src/app/api/accounts/credits/route.ts` |
| `POST /api/kie/generate` — create → poll → download | `src/app/api/kie/generate/route.ts` |
| Client service (never throws) | `src/services/kieApi.ts` |
| Concurrency-limited queue with retries | `src/services/GenerationQueue.ts` |
| Store (persist + IndexedDB split) | `src/store/generationStore.ts` |
| Learned credit rates | `src/lib/pricing.ts` |
| Gallery IndexedDB wrapper | `src/lib/galleryDb.ts` |
| ZIP / single download (base64 → Blob) | `src/lib/download.ts` |

**Any model.** Every image model kie.ai publishes is in the catalog with its own
input schema, and the settings panel is rendered from that schema — so Nano Banana
2 shows `resolution`/`aspect_ratio`/`output_format` pills while Seedream shows
`quality`, with no per-model UI code. A model kie added after the catalog was
generated can still be run: pick **Custom model id…**, type the id, and pass any
extra fields as JSON.

Regenerate the catalog when kie ships new models — every docs page also serves its
OpenAPI YAML at `<url>.md`, e.g. `https://docs.kie.ai/market/google/nanobanana2.md`.

**Character references.** Upload images in the character library; each is numbered.
Type `@1`, `@2` inline in a prompt to attach those references to it. Toggle "Pin to
all generations" to attach a character to *every* prompt in the batch. kie takes
image **URLs**, never bytes, so each reference is uploaded to kie's file API first;
uploads are cached by content hash, so a pinned character costs one upload per
batch rather than one per job. The per-call cap follows the selected model (14 for
Nano Banana 2, 8 for Pro, none at all for text-to-image-only models).

**Style bible.** Free text prepended to every prompt — the main lever for one
consistent look across a long run.

**Persistence split.** Settings, character library, style bible, queue config,
prompt text and learned credit rates persist to `localStorage`. The generated
gallery goes to **IndexedDB** (base64 images are far too large for localStorage),
so it survives a refresh; live `jobs`/`progress`/`queueState` are in-memory and
reset on reload, by design. "Clear gallery" wipes IndexedDB.

## Videos

The **Videos** tab is a storyboard: drop ten images at once and you get ten rows,
each with its own prompt, model, duration, resolution and aspect ratio. Rows are
independent kie tasks, so a single batch can mix models and lengths freely. An
"apply to all rows" bar sets any of those across every row at once, and the
concurrency control decides how many render simultaneously.

| | Veo 3.1 Lite (`veo3_lite`) | Grok Image-to-Video |
| --- | --- | --- |
| kie API | `/api/v1/veo/*` (its own namespace) | `jobs/createTask` |
| Duration | 4, 6, 8s | 6–30s, any whole second |
| Resolution | 720p, 1080p, 4k | 480p, 720p |
| Aspect | 16:9, 9:16, Auto | 16:9, 9:16, 1:1, 3:2, 2:3 |
| Measured | ~1 min when it works, 30 cr for 4s/720p | ~1 min, 9.6 cr for 6s/480p |

The two models share nothing but a shape: different endpoints, different request
bodies (`imageUrls` vs `input.image_urls`), different completion signals
(`successFlag` vs `state`), and Grok wants its duration as a *string*.
`src/lib/videoModels.ts` describes both, and `clampToModel` snaps a row's
settings when you switch its model — Veo can't do 30s, Grok can't do 1080p.

**Start, then poll — never one long request.** `POST /api/kie/video/start`
creates the task and returns its id immediately; the browser polls
`GET /api/kie/video/status`. A Veo render has been observed taking over sixteen
minutes, and an HTTP request held open that long dies to any timeout in between,
losing a task that has already been billed.

**Retrying resumes; it does not re-pay.** A row keeps its `taskId`, so retrying
after a dropped connection or a transient error waits on the render already in
flight. The id is cleared only when the render genuinely failed, or when you
change the prompt or settings — at which point the old task is the wrong clip
anyway. This matters: kie bills for Veo tasks that fail upstream.

**Clips are stored as Blobs in IndexedDB**, not base64 — a 20MB clip would
become a 27MB string, and a batch of ten would not survive. They're downloaded
through `/api/kie/video/file`, a proxy that exists because kie's CDN sends no
CORS headers; it allowlists kie's media hosts so it can't be used as an open
proxy.

## Cost

kie.ai bills in credits, and its docs don't publish a per-model rate — the
authoritative number is `creditsConsumed` on the finished task. So the app records
what each finished job actually cost, keyed by model plus the settings that affect
price, and estimates from those observations. A model you haven't run yet shows
"unknown" rather than a made-up number; one image fixes that.

The dollar figures are a convenience conversion at $0.005/credit, derived from a
measured run (Nano Banana 2 at 1K billed 8.0 credits against kie's published
$0.04). Credits are the real unit — check <https://kie.ai> for billed truth.

## Known limitations

- **Veo 3.1 Lite renders inconsistently, and failures are still billed.**
  Measured 2026-07-31 across three tasks: one succeeded in ~1 minute, two ran
  ~16 minutes and returned `errorCode 500 — "The upstream API service timed out
  and no results were returned"`. The failed ones were **billed anyway** (~30 cr
  each). The app marks that error retryable and resumes an in-flight task rather
  than paying for a second render, but the failure is upstream and nothing here
  can fix it. Grok Image-to-Video succeeded every time, in about a minute.
- **Veo spend is estimated, not reported.** kie's Veo namespace returns no
  per-task credit figure — unlike every other model, whose `creditsConsumed` is
  authoritative. Veo clips are costed from a measured rate (30 cr for 4s/720p,
  derived from the account balance) and shown with a `≈`. Trust the balance.
- **No callbacks.** Everything polls, because a callback needs a public URL and
  this app runs on localhost. A task that outlives the polling window is reported
  as still running rather than abandoned — it may still finish and bill.
- **Result URLs expire.** kie deletes generated images after ~24h and uploads after
  3 days. The app downloads every result immediately and stores the bytes locally,
  so the gallery keeps working; `sourceUrl` on an old image will 404.
- **Custom models get no reference images.** The image field's name varies per
  model (`image_input`, `image_urls`, `input_urls`, …) and isn't known for a model
  outside the catalog, so references are dropped for custom ids.
- **Resolution mismatch flagging** only applies to models with a `resolution` field
  naming a tier. Models that express size as `quality` or `image_size` have no tier
  to compare the returned pixels against.
