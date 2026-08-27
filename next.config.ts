import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
