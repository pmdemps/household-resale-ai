import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  poweredByHeader: false,
  // No server-action body-size bump: photos go browser → Supabase Storage directly (components/photo-uploader.tsx),
  // so server actions only ever carry small form fields.
};
export default nextConfig;
