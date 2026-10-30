import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Gold tile with a simple sunflower mark: eight petals around a seed head. */
export default function AppleIcon() {
  const petals = [0, 45, 90, 135, 180, 225, 270, 315];
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#f2b705" }}>
        <svg width="120" height="120" viewBox="0 0 64 64">
          {petals.map(a => <ellipse key={a} cx="32" cy="17" rx="4.6" ry="9.5" fill="#3b2a14" transform={`rotate(${a} 32 32)`} />)}
          <circle cx="32" cy="32" r="8.5" fill="#3b2a14" />
          <circle cx="32" cy="32" r="4" fill="#f2b705" opacity="0.6" />
        </svg>
      </div>
    ),
    size,
  );
}
