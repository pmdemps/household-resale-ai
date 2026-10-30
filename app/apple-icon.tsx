import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#65a8ff" }}>
        <svg width="110" height="110" viewBox="0 0 64 64">
          <path d="M20 24h24l-2.5 22a3 3 0 0 1-3 2.7H25.5a3 3 0 0 1-3-2.7L20 24Z" fill="none" stroke="#0b1020" strokeWidth="4" strokeLinejoin="round" />
          <path d="M26 24v-3a6 6 0 0 1 12 0v3" fill="none" stroke="#0b1020" strokeWidth="4" strokeLinecap="round" />
        </svg>
      </div>
    ),
    size,
  );
}
