# Bulk AI Generator

Bulk **image** and **video** generation through the **kie.ai** API — any of its 40
image models plus Veo 3.1 Lite and Grok Image-to-Video, with multi-account key
support, a character-reference library, a style bible for cross-batch
consistency, and a credit estimate learned from what kie actually bills.

Plus a **video editor** (`/editor`) that cuts a generated batch to a voiceover:
name each image for the second it should appear at, drop in the audio, and it
renders a 1080p MP4 with ffmpeg.

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

## Talking avatars

Two more video models, both on kie's ordinary `jobs/createTask` alongside Grok:
`kling/ai-avatar-standard` and `kling/ai-avatar-pro`. They take a portrait, a
voice track and a prompt, and lip-sync the face to the voice.

They are **audio-driven**, which makes them a different shape from everything
else here: the audio *is* the clip. There's no duration to pick — the cut sets
the length — and no resolution or aspect ratio, so an avatar row hides those
controls and shows the cut instead. The prompt becomes optional (kie requires
the field, not its content); the voice track is the thing that can't be missing,
and `isRunnable` flips accordingly.

**One recording, many cuts.** Voice tracks are loaded once into a shelf above
the storyboard, not per row, because a two-minute narration usually feeds a
dozen rows that each want a different ten seconds of it. "→ all rows" hands
every row the same track and leaves each one its own cut.

The **trimmer** is a modal with a 200px waveform, a ruler whose step adapts to
the zoom (per-second when you're close, per-minute when you're not), draggable
edges, scroll-to-zoom about the cursor, a pan bar, looped playback of just the
selection, and 5/10/15/20/30s presets. It shows the resulting filename live.

**The cut happens on the server**, in ffmpeg, not in the browser. A stream copy
can only cut on a frame boundary — the clip would start up to a frame early and
the lip-sync would inherit that error — so it re-encodes: `-ss`/`-t` into mono
44.1kHz AAC. Fifteen seconds lands around 240 KB, which matters when every row
uploads one. Measured accurate to a fortieth of a second, and verified to come
from the right place in the track.

**Uploads are content-addressed.** The browser hashes the file and the server
stores it under that hash, so attaching the same recording to twenty rows
uploads it once and re-attaching it tomorrow uploads it not at all. There's no
registry to keep in sync — the id *is* the filename. Tracks are swept after a
day.

**Naming: track plus cut point.** A cut taken at 1:35 of `narration.mp3` saves
as `narration_1-35.mp4`. The suffix is in the same cue form the rest of the app
reads, so those clips also drop straight onto the video editor's timeline at
that moment. An explicit `#cue` in the row's prompt still wins.

Everything else is inherited: the same account and credit balance, the queue
with its concurrency and retries, resume-don't-repay on `taskId`, the gallery.
Because an avatar row has no duration field, `shotSize()` reports the cut's
length instead — otherwise every talking clip would be labelled with a stale
number and the learned credit rates would be keyed on a lie.

## Naming output with `#cues`

A prompt can name the file it produces. Start a line with `#` and the rest of
that line becomes the filename:

```
#0-00
Wolves howling on a dark ridge above an empty valley at night, raw phone photo
look, natural lighting, no color grading, realistic and unedited

#0-05
Small canvas wall tent pitched on a grassy bench above a creek, yellow
cottonwoods, early October, raw phone photo look, natural lighting, realistic
and unedited
```

That saves `0-00.png` and `0-05.png` — no index prefix, no slug of the prompt
text. Which is the whole point: those names are exactly what the video editor
reads back as timestamps, so a batch comes out of the generator already an edit.
Generate, download the ZIP, drop the folder on `/editor`, done.

**A cue switches the box to blocks.** Normally one non-blank line is one prompt.
As soon as any `#cue` appears, every line under a cue belongs to that prompt
until the next cue — which is the only way to write a prompt that spans lines,
and it makes a 400-character shot description readable. Text above the first cue
still reads one-per-line. A box with no cues behaves exactly as it always did.

**The cue never reaches the model.** It's a filename, not part of the prompt.
`@N` character tags are unaffected and still work inside a cue block.

**Clips inherit cues too.** A `#cue` in a video row's prompt names the clip. So
does the source still, if the still is itself named for a timestamp — animate
`0-00.png` and you get `0-00.mp4`. A still with an ordinary name is left alone.
Talking-avatar rows take their name from the voice track and the cut point
instead: see [Talking avatars](#talking-avatars).

The tag is scrubbed to `A-Za-z0-9._-` before it touches the filesystem, so a cue
can't write outside the download. Two prompts sharing a cue is flagged in the
input panel; the second file is saved as `0-00 (2).png`, deliberately a form the
editor's parser rejects, so the duplicate lands in the folder unplaced rather
than silently stealing the slot.

## Video editor

`/editor` turns a folder of stills and an audio track into an MP4. It's built for
the output of the Images tab: generate a hundred frames for a narration, name
each one for its cue, and the edit assembles itself.

**The filename is the edit.** An image called `0-08.png` appears at 0:08 and
holds until the next image's cue; the last one holds until the audio ends. There
is no other timeline data — no project file, no manual dragging. `mm-ss` is the
main form (colons aren't legal in filenames on Windows); `h-mm-ss`, `mm_ss`,
bare `mmss`, decimals like `0-08.5`, and a cue on the end of a longer name
(`shot-03_1-12`) all parse too. Anything unreadable is listed rather than
silently dropped, and the Cues panel shows what every name resolved to.

**Subtle motion, without the shake.** Each image can drift 2–20% larger (or
smaller, or alternating) across its slot.

The obvious filter for this is `zoompan`, and it is the wrong one: it truncates
its crop origin to a whole source pixel. A gentle zoom moves that origin by well
under a pixel per frame, so the picture holds still for two or three frames and
then snaps. Measured on an 8s clip at 8%, **70% of frames didn’t move at all** —
which the eye reads as shake, not drift. Supersampling the source only shrinks
the steps; it never removes them (3× still left 54% of frames frozen), and the
extra up-then-down resample costs real sharpness.

So the zoom is a per-frame `perspective` transform instead, whose corners are
floats resolved to a 256th of a pixel. Same measurement: **0% frozen frames**,
and it keeps nearly twice as much fine detail, because it resamples once at 1:1
rather than scaling up and back down.

**Cuts land on the exact frame.** Every boundary is `round(t × fps)` computed
from the absolute cue, not accumulated clip by clip — sizing each clip from its
own duration would drift several frames off the narration by the hundredth
image.

**How the render works.** Each clip is encoded on its own to an MPEG-TS segment,
a few at a time across the cores; the final pass concatenates them by *copying*
the streams and muxes the audio in, so ten minutes of video is only ever encoded
once. Every segment uses identical codec settings, which is what makes the copy
safe. Measured on a 10-core M-series: **10 minutes of 1080p30 with zoom, from
100 images, in about two minutes** — five times faster than realtime. Worker
count is flat between 4 and 9 on that machine; the zoom filter, not the
scheduler, is the limit.

ffmpeg is not a system dependency — `ffmpeg-static` and `ffprobe-static` ship the
binaries, and `serverExternalPackages` in `next.config.ts` keeps them out of the
bundle so their paths still resolve.

**The editor only runs locally, and says so on a deployment.** It shells out to
ffmpeg, keeps a job's uploads on disk between requests, and takes minutes — none
of which a serverless host offers: instances don't share a filesystem, they're
recycled between requests, and a function is capped at 300 seconds. The
binaries alone (388 MB) exceed the 250 MB function limit. So a deployed copy
detects the host, shows a banner, and disables Export rather than failing with
"no such editing session" after a few hundred megabytes of upload. The timeline
and preview still work there, which is enough to check the cue names before
exporting at home.

**Uploads are chunked into 4 MB pieces.** `src/proxy.ts` matches every route, and
Next buffers a proxied request body in memory up to 10 MB — past that it
*truncates silently and serves the request anyway*. A ten-minute WAV sent whole
would arrive as a fragment with no error. Chunking stays well under the limit and
gives the progress bar real bytes to report.

Uploads, intermediates and the finished file live in a job directory under the OS
temp dir, swept after six hours. Nothing is written into the repo, and the editor
holds no state the generator can see.

| Control | Default | Notes |
| --- | --- | --- |
| Resolution | 1080p | 16:9 throughout; 720p/1440p/4K also offered |
| Frame rate | 30 fps | 24 / 25 / 30 / 60 |
| Zoom | in | none / in / out / alternate |
| Zoom amount — stills | 8% | 0–20% |
| Zoom amount — motion clips | 4% | 0–20%, separate because the shot already moves |
| Encoder | x264 | see below |
| Before the first image | hold it | only shown when the first cue isn't 0:00 |
| Audio fade out | 1.5s | trailing fade on the bed |

**x264 beats the hardware encoder here**, which is the opposite of the usual
advice: clips encode several at a time, so x264 already uses every core, while
VideoToolbox serialises on one engine. Measured at 1080p30 it was ~20% slower
than x264 *and* produced a larger file. It's kept as an option for machines with
few cores, or when you want the CPU back while a render runs.

## Clips on the timeline

The editor takes video alongside stills, placed by the same filename cue, and
works out for itself what each one is. That closes the loop: generate the
stills, generate the talking clips, generate the motion clips, drop the folder,
export. No assembly by hand.

**Three kinds, detected in the browser.** A dropped `.mp4` is probed with a
`<video>` element for its length, and its audio track is decoded. No audio track
at all means a generated motion clip. Audio that correlates with the narration
bed means a talking avatar. Audio that doesn't correlate is left as a motion
clip and flagged, because it's usually a clip from a different take.

**Talking clips find their own position.** The filename is a hint, not a
commitment: the clip carries the audio it was generated from, so cross-
correlating its loudness envelope against the bed recovers the true offset. In
testing that's exact — 0 ms error from hints 0.4s, 1.4s and 5.4s out, and from
no hint at all, surviving a lossy re-encode at a different rate and level. It
also refuses to guess: unrelated audio scores 0.12 against a real match's 0.95.
So the manual nudge to line lips up with the bed is gone.

Match on the *speech only*, though. A clip usually ends on a beat of silence the
bed doesn't have at that moment, and letting that tail into the comparison drags
a real match below the threshold — which is exactly what happened the first time.

**Talking clips are anchored.** They keep their full length and are never cut
short; everything else gives way. A still cued underneath one waits until it
finishes, and a still left with less than `minVisualSeconds` of room is skipped
rather than flashed, with the next visual taking its slot.

**Never black between visuals.** A cue that follows a clip is treated as stale —
the clip's length came from its speech or from how far it stretched, not from
anyone's filename — so the next visual is pulled back to meet it rather than
waiting for its own timestamp. The last visual runs to the end of the audio for
the same reason. The only black left is a lead-in before the first visual, where
there is genuinely nothing to show.

Two overlapping avatars is the one conflict it won't paper over: pushing the
second breaks its lip sync, which is the whole point of it, so it warns instead.

**Trailing silence is trimmed.** The clip ends when the mouth stops, not when the
file does, and the next visual comes in there. Detection is accurate to ~10 ms
and flat across a −25 to −45 dB threshold, so it needs no tuning. The same
detection belongs on the audio *before* generating, where it stops you paying
for silence.

**Motion clips take their own zoom amount.** Kept separate from the stills
amount because what reads as a gentle drift over a photograph is usually too
much on top of footage that is already moving; 0 leaves clips alone. Until this
was added they took no zoom at all — the render's video branch simply had none
in it, so the setting was accepted and quietly ignored.

**Motion clips stretch to fill their gap.** The next cue decides the length, so a
4s clip becomes however long the slot is, with frames invented between the real
ones rather than repeated. Roughly 70 seconds of render per stretched clip at
1080p — the single most expensive thing in an export, and capped at `maxStretch`
because past about 2.5x the invention starts to show around fast movement.

**The audio bed plays throughout.** A talking clip's own audio is discarded: it
*is* the bed at that moment, so muting it loses nothing and the alignment
guarantees the lips match. The consequence worth knowing is that a clip
generated from audio outside the bed would play the bed instead — which is what
the confidence warning is for.

## Film look

Moving grain, flicker, vignette and faded curves, at four strengths, **and the
preview shows them** — the point of the setting is choosing before you
export, which is no use if you have to export to see it.

**No gate weave.** A projector really does drift a pixel or two, and it was in
here on the grounds of authenticity — but over a slideshow of stills it reads as
camera shake, and shake is not what anyone wants from a film look. Removed from
both the render and the preview; measured at 0px of frame travel at every
strength.

The preview isn't the ffmpeg chain and can't be. It has to get the *decision*
right — whether this shot reads as filmic at this strength — so its grain is
calibrated against the render rather than picked by eye: sigma 3.3 / 8.2 / 12.8
on the canvas against the render's 3.5 / 7.5 / 13. Grain is pre-rendered into
tiles and blitted at a moving offset rather than generated per pixel, which
would cost more than everything else in the preview put together.

Two things that took measuring. Blending mid-grey noise with `overlay` — the
obvious approach — is nearly a no-op on a dark image, which is exactly where
grain should show; splitting it into a bright half added with `lighter` and a
dark half blended over approximates ffmpeg's signed additive noise and survives
any exposure. And alpha saturates, so past a point more opacity stops adding
variance: heavy needs a second pass to land meaningfully coarser than medium
rather than a hair above it.
The two that sell it only exist in motion: grain that re-randomises every frame
rather than a fixed overlay, and a pixel or two of gate weave — deliberately
integer, because real gate weave is a mechanical judder, not a glide.

**Neither the look nor the zoom goes near a talking face.** A zoom on someone
speaking reads as a mistake, and grain fights the one thing the viewer is trying
to read. Which kinds get effects is a setting; avatars are excluded in the
client, and again in the render route, so a hand-made request can't override it.

Grain is noise and noise is what H.264 spends bits on, so a heavy setting grows
the file noticeably. That's the cost, not a bug.

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
- **The editor re-uploads on every export.** Images go to the server as part of
  starting a render, so changing one setting and exporting again sends them all a
  second time. Over localhost that's seconds; over the LAN it isn't.
- **The editor's timeline lives in the tab.** Settings persist to `localStorage`,
  but the files themselves can't — reloading means picking the folder again.
- **Cuts are hard cuts.** No cross-fades, and no per-clip effect overrides; the
  motion and film settings apply per kind, not per clip.
- **The preview's film look is an approximation.** Calibrated to the render's
  grain strength, but canvas filters aren't ffmpeg's `curves` — the tint will
  differ slightly. The export is the authority.
- **Settings are merged, not replaced, on load.** `settings` persists as one
  object, and zustand's default merge swaps it wholesale — so a browser holding
  it from an older build comes back missing every field added since, and the
  first render that reads one throws. Both stores layer the saved values over
  the current defaults instead. Bumping `version` is *not* the fix: without a
  `migrate` it discards the saved state, which stops the crash by resetting
  everything the user chose.
- **Clip detection needs the bed loaded first.** A talking clip dropped before
  the narration has nothing to correlate against and lands as a motion clip.
  Loading or changing the audio re-runs the match over every clip, so the fix is
  to drop the audio and let it settle.
- **Avatar pricing is unverified.** The Kling avatar models are wired from
  kie's published schema but have not been run here, so their credit cost is
  unknown until the first clip comes back and `creditsConsumed` teaches the rate
  table. Budget the first batch small.
- **Avatar cuts are capped by the request body, not the model.** Kling accepts
  five minutes of audio; a cut has to fit in one request alongside the portrait,
  which in practice means about a minute. Longer cuts drop their sample rate and
  then refuse.
- **`imagesPerPrompt` above 1 fights with cues.** Only one file can hold a given
  name, so the extra variants are saved as `0-00 (2).png` and are not placed on
  the timeline — pick the one you want and rename it. Cues are designed for the
  one-image-per-prompt case.
