/**
 * ffprobe-static ships no typings. It exports the absolute path of the ffprobe
 * binary for the current platform, which is all the editor's render pipeline
 * asks of it.
 */
declare module "ffprobe-static" {
  const ffprobe: { path: string };
  export = ffprobe;
}
