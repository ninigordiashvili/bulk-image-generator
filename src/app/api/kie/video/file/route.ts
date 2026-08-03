import type { NextRequest } from "next/server";

export const maxDuration = 300;

/**
 * Hosts kie serves generated media from. This is an allowlist, not a
 * convenience: without it the route is an open proxy that will fetch any URL a
 * page hands it, including internal addresses.
 */
const ALLOWED_HOSTS = new Set([
  "tempfile.aiquickdraw.com",
  "tempfile.redpandaai.co",
  "file.aiquickdraw.com",
  "kieai.redpandaai.co",
]);

const ALLOWED_SUFFIXES = [".kie.ai", ".aiquickdraw.com", ".redpandaai.co"];

function isAllowed(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  if (ALLOWED_HOSTS.has(url.hostname)) return true;
  return ALLOWED_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix));
}

/**
 * Streams a finished video back to the browser. It exists because kie's CDN
 * doesn't send CORS headers, so the page can't fetch the clip itself — and the
 * bytes have to reach the browser to be stored locally before the URL expires.
 */
export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("url");
  if (!raw) return new Response("Missing url.", { status: 400 });

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return new Response("Malformed url.", { status: 400 });
  }
  if (!isAllowed(url)) {
    return new Response(
      `Refusing to proxy ${url.hostname} — only kie.ai media hosts are allowed.`,
      { status: 403 }
    );
  }

  const upstream = await fetch(url, { signal: request.signal }).catch(() => null);
  if (!upstream?.ok || !upstream.body) {
    return new Response(`Upstream returned ${upstream?.status ?? "no response"}.`, {
      status: 502,
    });
  }

  // Streamed rather than buffered: a 1080p clip can be tens of megabytes and
  // there's no reason to hold it in the server's memory on the way past.
  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "video/mp4",
      ...(upstream.headers.get("content-length")
        ? { "Content-Length": upstream.headers.get("content-length")! }
        : {}),
      "Cache-Control": "no-store",
    },
  });
}
