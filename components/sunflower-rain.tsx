/**
 * Decorative "raining sunflowers" backdrop for the light (Sunflower) theme: the light-side twin of
 * CashRain. Small sunflowers drift down behind the page using the same pure-CSS fall and sway as the
 * banknotes (see .sunflower-rain in globals.css). Hidden in the dark theme and for people who ask for
 * reduced motion; invisible to screen readers.
 */

// Fixed, hand-picked values so the server and client render the same markup (no Math.random).
// Offset from CashRain's columns so the two never look like the same pattern.
const FLOWERS = [
  { left: 5, size: 44, dur: 16, delay: -3, spin: 1 },
  { left: 11, size: 32, dur: 21, delay: -12, spin: -1 },
  { left: 18, size: 50, dur: 17, delay: -7, spin: 1 },
  { left: 25, size: 36, dur: 23, delay: -16, spin: -1 },
  { left: 31, size: 46, dur: 15, delay: -10, spin: 1 },
  { left: 37, size: 34, dur: 20, delay: -4, spin: -1 },
  { left: 44, size: 52, dur: 18, delay: -13, spin: 1 },
  { left: 50, size: 38, dur: 22, delay: -8, spin: -1 },
  { left: 56, size: 46, dur: 19, delay: -2, spin: 1 },
  { left: 62, size: 32, dur: 24, delay: -17, spin: -1 },
  { left: 68, size: 48, dur: 16, delay: -6, spin: 1 },
  { left: 74, size: 38, dur: 21, delay: -14, spin: -1 },
  { left: 80, size: 50, dur: 18, delay: -9, spin: 1 },
  { left: 87, size: 34, dur: 23, delay: -5, spin: -1 },
  { left: 93, size: 44, dur: 17, delay: -15, spin: 1 },
  { left: 2, size: 30, dur: 26, delay: -20, spin: -1 },
  { left: 21, size: 30, dur: 25, delay: -22, spin: 1 },
  { left: 47, size: 30, dur: 27, delay: -19, spin: -1 },
  { left: 71, size: 30, dur: 25, delay: -21, spin: 1 },
  { left: 97, size: 30, dur: 26, delay: -18, spin: -1 },
];

export function SunflowerRain() {
  return (
    <div aria-hidden className="sunflower-rain pointer-events-none fixed inset-0 -z-10 select-none overflow-hidden">
      {FLOWERS.map((f, i) => (
        <span
          key={i}
          className="sunflower-drop"
          style={
            {
              left: `${f.left}%`,
              width: f.size,
              animationDuration: `${f.dur}s, ${f.dur / 4}s`,
              animationDelay: `${f.delay}s, ${f.delay}s`,
              "--spin": f.spin,
            } as React.CSSProperties
          }
        >
          <LittleSunflower />
        </span>
      ))}
    </div>
  );
}

const PETALS = Array.from({ length: 12 }, (_, i) => i * 30);

function LittleSunflower() {
  return (
    <svg viewBox="-50 -50 100 100" width="100%" role="presentation">
      <g fill="#d99a06">
        {PETALS.map(a => (
          <ellipse key={"b" + a} cx="0" cy="-30" rx="8" ry="18" transform={`rotate(${a + 15})`} />
        ))}
      </g>
      <g fill="#f2b705">
        {PETALS.map(a => (
          <ellipse key={"f" + a} cx="0" cy="-28" rx="8.5" ry="19" transform={`rotate(${a})`} />
        ))}
      </g>
      <circle r="17" fill="#6b4423" />
      <circle r="13" fill="#4e2e14" />
      <circle r="8" fill="none" stroke="#8a5a2b" strokeWidth="2.2" strokeDasharray="0.1 4.4" strokeLinecap="round" />
    </svg>
  );
}
