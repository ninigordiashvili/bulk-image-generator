import { NextResponse } from "next/server";
import { usageSummary, vertexTarget } from "@/server/vertex";
import { VERTEX_IMAGE_MODELS, VERTEX_VIDEO_MODELS } from "@/lib/vertexModels";
import { imageRate, videoRate } from "@/lib/vertexPricing";

/**
 * Spend so far, and what each model costs.
 *
 * Two things this deliberately does not claim. It is not your Google bill — the
 * figure is this server's own count multiplied by a local rate table, so it
 * misses anything generated from the Cloud console, another machine, or a
 * previous run of this server. And it is not your credit balance: Google exposes
 * no API for the remaining credit on a billing account, only budgets, so the
 * true number lives in the console and nowhere else.
 *
 * What it is good for is the thing that actually goes wrong — noticing that a
 * bulk run is costing more per image than expected, before it has done it four
 * hundred times.
 */
export async function GET() {
  const { project, location } = vertexTarget();

  return NextResponse.json({
    ok: true,
    project,
    location,
    usage: usageSummary(),
    rates: {
      images: VERTEX_IMAGE_MODELS.map((model) => {
        const rate = imageRate(model.id);
        return {
          model: model.id,
          label: model.label,
          usd: rate.usd,
          unit: "per image",
          verified: rate.verified,
        };
      }),
      videos: VERTEX_VIDEO_MODELS.map((model) => {
        // Both rates, because audio is a price decision as much as a creative
        // one and the difference is several times the silent rate.
        const silent = videoRate(model.id, false);
        const withAudio = videoRate(model.id, true);
        const perClip = (usd: number) =>
          model.durations.map((seconds) => ({
            seconds,
            usd: Number((usd * seconds).toFixed(3)),
          }));
        return {
          model: model.id,
          label: model.label,
          unit: "per second",
          silent: { usd: silent.usd, verified: silent.verified, perClipUsd: perClip(silent.usd) },
          withAudio: {
            usd: withAudio.usd,
            verified: withAudio.verified,
            perClipUsd: perClip(withAudio.usd),
          },
        };
      }),
    },
    billingConsole:
      `https://console.cloud.google.com/billing?project=${project}` +
      " — the only authoritative view of the remaining credit.",
  });
}
