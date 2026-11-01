import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  poweredByHeader: false,
  // No server-action body-size bump: photos go browser → Supabase Storage directly (components/photo-uploader.tsx),
  // so server actions only ever carry small form fields.
  async headers() {
    return [
      {
        // The notification service worker: always fetch the newest copy, and let it load nothing but our own code.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};
export default nextConfig;
