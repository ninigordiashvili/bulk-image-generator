/**
 * Whether this copy can render at all.
 *
 * The editor shells out to ffmpeg, writes hundreds of megabytes of
 * intermediates, and needs the uploads from one request to still be there for
 * the next. A serverless host gives none of that: instances don't share a
 * disk, they're recycled between requests, and the function has a hard time
 * limit a feature-length render will not fit inside.
 *
 * Rather than let that surface as "no such editing session" after a long
 * upload, the editor checks up front and says so.
 */
export function canRender(): boolean {
  return !process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME;
}

export const NO_RENDER_REASON =
  "This copy is deployed to a serverless host, which has no persistent disk " +
  "and a hard time limit on a request — so it can't render video. Run the app " +
  "locally (npm run dev) to use the editor; everything else works here.";
