import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Photo uploads go through server actions as multipart form data: up to 12 photos of 10 MB each
  // per item, but a phone usually sends 2-5 at a time. The default limit is 1 MB.
  experimental: { serverActions: { bodySizeLimit: "25mb" } },
};
export default nextConfig;
