import type { NextConfig } from "next";

// The Express server (index.js) lives one directory up and serves
// /metrics, /health and /config/* on port 8002. All dashboard fetches
// go through this rewrite, so the browser never talks to the backend
// directly (no CORS anywhere).
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8002";

const nextConfig: NextConfig = {
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
