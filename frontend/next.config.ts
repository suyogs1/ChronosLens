import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_WS_URL: "wss://chrono-lens-backend-434492372587.us-central1.run.app/ws/live"
  }
  /* config options here */
};

export default nextConfig;
