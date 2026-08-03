import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev server binds 0.0.0.0 already; this is what lets another machine on the
  // LAN load the dev-only assets (HMR socket, /_next internals) without being
  // blocked as a cross-origin request. Not used by `next start`.
  allowedDevOrigins: ["192.168.100.*", "*.local"],
};

export default nextConfig;
