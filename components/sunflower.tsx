/**
 * Decorative sunflower for the Sunflower (light) theme: a ring of petals around a seed head,
 * drawn from scratch with basic shapes. Rendered behind the page in a corner, hidden in dark mode
 * (see .sunflower-corner in globals.css), and invisible to screen readers.
 */
export function SunflowerCorner() {
  const petals = Array.from({ length: 18 }, (_, i) => i * 20);
  return (
    <div
      aria-hidden
      className="sunflower-corner pointer-events-none fixed -right-16 bottom-16 -z-10 h-[300px] w-[300px] select-none opacity-[0.34] lg:-bottom-10 lg:-right-10 lg:h-[380px] lg:w-[380px]"
    >
      <svg viewBox="-160 -160 320 320" width="100%" height="100%" role="presentation">
        {/* stem and leaf */}
        <path d="M6 70 C 14 120, 4 160, 10 200" fill="none" stroke="#4f7a2f" strokeWidth="9" strokeLinecap="round" />
        <path d="M10 150 C -30 130, -52 140, -62 176 C -30 180, -2 170, 10 150 Z" fill="#6a9a3c" />
        <path d="M10 150 C -14 158, -36 166, -58 174" fill="none" stroke="#4f7a2f" strokeWidth="2.5" strokeLinecap="round" />
        {/* back ring of petals, slightly deeper gold */}
        <g fill="#d99a06">
          {petals.map(a => (
            <ellipse key={"b" + a} cx="0" cy="-86" rx="13" ry="40" transform={`rotate(${a + 10})`} />
          ))}
        </g>
        {/* front ring of petals */}
        <g fill="#f2b705">
          {petals.map(a => (
            <ellipse key={"f" + a} cx="0" cy="-80" rx="15" ry="46" transform={`rotate(${a})`} />
          ))}
        </g>
        {/* petal creases */}
        <g stroke="#c98a05" strokeWidth="1.5" strokeLinecap="round" fill="none">
          {petals.map(a => (
            <path key={"c" + a} d="M0 -46 L0 -112" transform={`rotate(${a})`} />
          ))}
        </g>
        {/* seed head */}
        <circle r="50" fill="#6b4423" />
        <circle r="42" fill="#4e2e14" />
        <g fill="none" stroke="#8a5a2b" strokeWidth="3" strokeLinecap="round">
          <circle r="34" strokeDasharray="0.1 6.1" />
          <circle r="26" strokeDasharray="0.1 6.3" transform="rotate(12)" />
          <circle r="18" strokeDasharray="0.1 6.5" transform="rotate(25)" />
          <circle r="10" strokeDasharray="0.1 7" transform="rotate(40)" />
        </g>
        <circle r="3" fill="#8a5a2b" />
      </svg>
    </div>
  );
}
