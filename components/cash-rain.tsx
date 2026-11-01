/**
 * Decorative "raining cash" backdrop for the dark theme: faint banknotes drifting down behind
 * the page. Pure CSS animation (see .cash-rain in globals.css), so it costs no JavaScript.
 * Hidden in the light theme and for people who ask for reduced motion; invisible to screen readers.
 */

// Fixed, hand-picked values so the server and client render the same markup (no Math.random).
const NOTES = [
  { left: 3, size: 54, dur: 14, delay: -2, spin: 1 },
  { left: 9, size: 40, dur: 19, delay: -11, spin: -1 },
  { left: 15, size: 62, dur: 16, delay: -6, spin: 1 },
  { left: 22, size: 46, dur: 21, delay: -15, spin: -1 },
  { left: 28, size: 58, dur: 13, delay: -9, spin: 1 },
  { left: 34, size: 42, dur: 18, delay: -3, spin: -1 },
  { left: 41, size: 66, dur: 15, delay: -12, spin: 1 },
  { left: 47, size: 44, dur: 20, delay: -7, spin: -1 },
  { left: 53, size: 56, dur: 17, delay: -1, spin: 1 },
  { left: 59, size: 40, dur: 22, delay: -16, spin: -1 },
  { left: 65, size: 60, dur: 14, delay: -5, spin: 1 },
  { left: 71, size: 48, dur: 19, delay: -13, spin: -1 },
  { left: 77, size: 64, dur: 16, delay: -8, spin: 1 },
  { left: 83, size: 42, dur: 21, delay: -4, spin: -1 },
  { left: 89, size: 54, dur: 15, delay: -14, spin: 1 },
  { left: 95, size: 46, dur: 18, delay: -10, spin: -1 },
  { left: 12, size: 36, dur: 24, delay: -19, spin: -1 },
  { left: 38, size: 38, dur: 23, delay: -20, spin: 1 },
  { left: 62, size: 36, dur: 25, delay: -18, spin: -1 },
  { left: 86, size: 38, dur: 23, delay: -21, spin: 1 },
];

export function CashRain() {
  return (
    <div aria-hidden className="cash-rain pointer-events-none fixed inset-0 -z-10 select-none overflow-hidden">
      {NOTES.map((n, i) => (
        <span
          key={i}
          className="cash-note"
          style={
            {
              left: `${n.left}%`,
              width: n.size,
              animationDuration: `${n.dur}s, ${n.dur / 4}s`,
              animationDelay: `${n.delay}s, ${n.delay}s`,
              "--spin": n.spin,
            } as React.CSSProperties
          }
        >
          <Banknote />
        </span>
      ))}
    </div>
  );
}

function Banknote() {
  return (
    <svg viewBox="0 0 100 50" width="100%" role="presentation">
      <rect x="1" y="1" width="98" height="48" rx="4" fill="#2f6b3a" stroke="#4f9a5c" strokeWidth="2" />
      <rect x="7" y="7" width="86" height="36" rx="2" fill="none" stroke="#5fae6b" strokeWidth="1.2" opacity="0.7" />
      <ellipse cx="50" cy="25" rx="13" ry="15" fill="#3d8248" stroke="#6cc078" strokeWidth="1.2" />
      <text x="50" y="32" textAnchor="middle" fontSize="20" fontWeight="700" fill="#9be2a5" fontFamily="system-ui, sans-serif">$</text>
      <circle cx="18" cy="25" r="5" fill="none" stroke="#6cc078" strokeWidth="1.2" />
      <circle cx="82" cy="25" r="5" fill="none" stroke="#6cc078" strokeWidth="1.2" />
    </svg>
  );
}
