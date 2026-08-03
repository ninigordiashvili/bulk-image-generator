import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * A password gate for the deployed copy. Locally there is no one else on the
 * machine, but a public URL is reachable by anyone who finds it — and this app
 * has no per-user anything, so a stranger who loads it spends the kie.ai
 * credits of whoever's key is in the environment.
 *
 * HTTP Basic rather than a login page: the browser stores the credentials and
 * replays them on every request to this origin, so the API routes are covered
 * by the same check as the page, with no session handling and no UI.
 */
const REALM = 'Basic realm="Bulk AI Generator", charset="UTF-8"';

export function proxy(request: NextRequest) {
  const expected = process.env.APP_PASSWORD?.trim();

  if (!expected) {
    // Unset in development means "I'm the only one here" — stay out of the way.
    // Unset in production is a misconfiguration, and failing open would hand out
    // the API key's spending power, so fail closed and say what's missing.
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return new Response(
      "APP_PASSWORD is not set on this deployment, so the app is refusing to serve. Set it in the host's environment variables and redeploy.",
      { status: 503 }
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");

  if (scheme?.toLowerCase() === "basic" && encoded) {
    let decoded = "";
    try {
      decoded = atob(encoded);
    } catch {
      decoded = "";
    }
    // Any username is fine; only the password is checked.
    const supplied = decoded.slice(decoded.indexOf(":") + 1);
    if (decoded.includes(":") && constantTimeEqual(supplied, expected)) {
      return NextResponse.next();
    }
  }

  return new Response("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": REALM },
  });
}

/**
 * Compares without leaking the answer through how long it took. A plain `===`
 * bails at the first differing character, which over many attempts tells an
 * attacker how much of a guessed prefix was right.
 */
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export const config = {
  // Everything except build assets — API routes very much included, since
  // that's where the spending happens.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
