import type { NextConfig } from "next";

// The Express server (index.js) lives one directory up and serves
// /metrics, /health and /config/* on port 8002. All dashboard fetches
// go through this rewrite, so the browser never talks to the backend
// directly (no CORS anywhere).
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8002";

const nextConfig: NextConfig = {
  // Standalone output for the Docker deploy: emits .next/standalone
  // with a minimal server.js (no node_modules in the image). NOTE:
  // the rewrites below are serialized at BUILD time — BACKEND_URL is
  // passed as a build ARG (internal service name) in the Dockerfile.
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/api/server/:path*",
        destination: `${BACKEND_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
