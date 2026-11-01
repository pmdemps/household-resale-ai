import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const RED = "#e0102a";

/**
 * Home-screen icon: a cardboard box stamped "GTFO" in red on a black tile. Same drawing as app/icon.svg,
 * but square: iOS rounds the corners itself and wants no transparency.
 */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "linear-gradient(135deg, #34343a, #0b0b0d)" }}>
        <svg width="180" height="180" viewBox="0 0 180 180">
          {/* open flaps, box, tape */}
          <path d="M32 70 L14 44 L86 44 L90 70 Z" fill="#a8692f" />
          <path d="M90 70 L94 44 L166 44 L148 70 Z" fill="#d9a066" />
          <rect x="32" y="68" width="116" height="86" rx="4" fill="#c98b4f" />
          <rect x="82" y="68" width="16" height="24" fill="#e8c48d" opacity="0.9" />
          {/* the stamp */}
          <g transform="translate(90 120) rotate(-9) scale(1.06) translate(-46.5 -13)">
            <rect x="-8" y="-7" width="109" height="40" rx="4" fill="none" stroke={RED} strokeWidth="4.5" />
            <g fill="none" stroke={RED} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 5 C14 1 9 0 6 1.5 C2 4 1 9 1 13 C1 19 4 25 10 25 C14 25 17 22 17 17 V14 H10" />
              <path transform="translate(25 0)" d="M0 1 H18 M9 1 V25" />
              <path transform="translate(50 0)" d="M15 1 H2 V25 M2 13 H12" />
              <ellipse transform="translate(75 0)" cx="9" cy="13" rx="8" ry="12" />
            </g>
          </g>
        </svg>
      </div>
    ),
    size,
  );
}
