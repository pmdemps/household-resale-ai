import { barPath, chartLayout, signedMoney, type MonthPoint } from "@/lib/money";
import { money } from "@/lib/types";

/** "$40", "$0", "−$20" for the axis. */
const tick = (v: number) => (v === 0 ? "$0" : `${v < 0 ? "−" : ""}$${Math.abs(v) % 1 === 0 ? Math.abs(v) : Math.abs(v).toFixed(2)}`);

/**
 * Month-by-month profit as a plain inline SVG column chart.
 * Bars grow from the zero line: green above it (made money), red below it (lost money).
 * The current month gets a highlight band and a bold label. Every bar has a native tooltip,
 * and the best, worst and current months carry a direct value label so the chart reads without hover.
 */
export function MonthlyProfitChart({ points, width = 640, height = 230, titleId }: { points: MonthPoint[]; width?: number; height?: number; titleId: string }) {
  const l = chartLayout(points, { width, height });
  const plotRight = width - 8;
  const plotBottom = height - l.padBottom;
  const values = points.map(p => p.profit);
  const best = Math.max(...values);
  const worst = Math.min(...values);
  const labelled = new Set<string>();
  for (const b of l.bars) {
    if (b.point.sold === 0) continue;
    if (b.point.isCurrent || (b.value === best && best > 0) || (b.value === worst && worst < 0)) labelled.add(b.point.key);
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-labelledby={titleId}>
      <title id={titleId}>{`Profit by month for the last ${points.length} months`}</title>

      {l.bars.filter(b => b.point.isCurrent).map(b => (
        <rect key="now" x={b.x + b.width / 2 - l.slotWidth / 2} y={l.padTop - 6} width={l.slotWidth} height={plotBottom - l.padTop + 6} rx={8} className="fill-accent/10" />
      ))}

      {l.ticks.map(t => (
        <g key={t.value}>
          <line x1={l.padLeft} x2={plotRight} y1={t.y} y2={t.y} className={t.value === 0 ? "stroke-slate-400" : "stroke-line"} strokeWidth={t.value === 0 ? 1.5 : 1} />
          <text x={l.padLeft - 7} y={t.y} textAnchor="end" dominantBaseline="middle" fontSize={11} className="fill-slate-500 tabular-nums">{tick(t.value)}</text>
        </g>
      ))}

      {l.bars.map(b => {
        const cx = b.x + b.width / 2;
        const valueY = b.positive ? b.y : b.y + b.height;
        const tip = `${b.point.longLabel}: ${b.point.sold === 0 ? "nothing sold" : `${signedMoney(b.value)} from ${b.point.sold} sale${b.point.sold === 1 ? "" : "s"}`}`;
        return (
          <g key={b.point.key}>
            <title>{tip}</title>
            {/* hit target wider than the bar so tapping the column shows the tooltip */}
            <rect x={cx - l.slotWidth / 2} y={l.padTop - 6} width={l.slotWidth} height={plotBottom - l.padTop + 6} fill="transparent" />
            {b.height > 0 ? (
              <path d={barPath(b.x, l.zeroY, valueY, b.width)} className={b.positive ? "fill-good" : "fill-bad"} />
            ) : (
              b.point.sold > 0 && <rect x={b.x} y={l.zeroY - 1.5} width={b.width} height={3} rx={1.5} className="fill-slate-400" />
            )}
            {labelled.has(b.point.key) && (
              <text x={cx} y={b.positive ? b.y - 6 : b.y + b.height + 13} textAnchor="middle" fontSize={11} fontWeight={600} className="fill-slate-200 tabular-nums">
                {signedMoney(b.value).replace(/\.00$/, "")}
              </text>
            )}
            <text x={cx} y={height - 8} textAnchor="middle" fontSize={11} fontWeight={b.point.isCurrent ? 700 : 400} className={b.point.isCurrent ? "fill-white" : "fill-slate-500"}>
              {b.point.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** The same numbers as a table, for screen readers, printing, and anyone who prefers a list. */
export function MonthTable({ points }: { points: MonthPoint[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-slate-500">
          <th className="pb-2 font-normal">Month</th>
          <th className="pb-2 text-right font-normal">Sold</th>
          <th className="pb-2 text-right font-normal">After fees</th>
          <th className="pb-2 text-right font-normal">Profit</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {[...points].reverse().map(p => (
          <tr key={p.key} className={p.isCurrent ? "font-semibold" : ""}>
            <td className="py-2 text-slate-200">{p.longLabel}{p.isCurrent ? " (now)" : ""}</td>
            <td className="py-2 text-right tabular-nums text-slate-300">{p.sold}</td>
            <td className="py-2 text-right tabular-nums text-slate-300">{p.sold ? money(p.net) : "—"}</td>
            <td className={"py-2 text-right tabular-nums " + (p.sold === 0 ? "text-slate-500" : p.profit > 0.004 ? "text-good" : p.profit < -0.004 ? "text-bad" : "text-slate-300")}>{p.sold ? signedMoney(p.profit) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
