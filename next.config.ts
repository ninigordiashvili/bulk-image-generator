import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // Pinned, because the automatic answer is wrong here: the root is found by
    // walking up for a lockfile, and a stray package-lock.json in the home
    // directory wins over this one. That root is what the dev server watches,
    // so it ends up watching the whole home directory — including, on Windows,
    // AppData\Local\Temp, where the editor writes its scratch. A join dropping
    // thirty megabytes there looked to the watcher like the project changing
    // under it, the server reloaded mid-request, and the finished audio came
    // back as "no such editing session". macOS hides the bug rather than
    // avoiding it: its temp dir is outside the home directory.
    root: __dirname,
  },

  // Dev server binds 0.0.0.0 already; this is what lets another machine on the
  // LAN load the dev-only assets (HMR socket, /_next internals) without being
  // blocked as a cross-origin request. Not used by `next start`.
  allowedDevOrigins: ["192.168.100.*", "*.local"],

  // ffmpeg-static and ffprobe-static both resolve a bundled binary relative to
  // their own directory, which only works if they're required at runtime instead
  // of being bundled into the route handler. The video editor shells out to them
  // for every render.
  //
  // @google/genai is here for the same class of reason: it finds Application
  // Default Credentials by walking the filesystem through google-auth-library,
  // which needs Node's real module resolution rather than a bundled copy.
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static", "@google/genai"],
};

export default nextConfig;
