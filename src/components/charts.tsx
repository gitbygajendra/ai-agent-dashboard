"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatCurrency, formatNumber } from "@/lib/utils";

/*
 * Shared chart components. Mark spec: 2px lines, ~10% area wash, bars <= 24px
 * with a 4px rounded data end, 1px solid recessive grid, tooltips on every
 * chart, legend only when there are 2+ series. Categorical colors come from
 * --chart-1..6 in fixed order (validated for CVD separation).
 */
export const SERIES = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"];
const GRID = "var(--border)";
const AXIS = { fontSize: 11, fill: "var(--muted-foreground)" };

function tooltipStyle() {
  return {
    contentStyle: { borderRadius: 8, border: "1px solid var(--border)", fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.06)" },
    labelStyle: { color: "var(--foreground)", fontWeight: 500 },
    itemStyle: { color: "var(--foreground)" },
  };
}

type ValueFormat = "number" | "currency";
function fmt(v: number, format: ValueFormat, currency: string, compact = false) {
  return format === "currency" ? formatCurrency(v, currency, compact) : formatNumber(v, 2);
}

export function TimeSeriesChart({
  data,
  xKey,
  yKey,
  label,
  format = "number",
  currency = "USD",
  height = 260,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string;
  label: string;
  format?: ValueFormat;
  currency?: string;
  height?: number;
}) {
  return (
    <div style={{ height }} role="img" aria-label={`${label} over time`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={24} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => fmt(v, format, currency, true)} />
          <Tooltip {...tooltipStyle()} formatter={(v) => [fmt(Number(v), format, currency), label]} />
          <Area type="monotone" dataKey={yKey} stroke={SERIES[0]} strokeWidth={2} fill={SERIES[0]} fillOpacity={0.1} dot={data.length <= 31 ? { r: 3, strokeWidth: 2, stroke: "var(--card)", fill: SERIES[0] } : false} activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--card)" }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal ranked bars (top items). One series, so no legend. */
export function BarListChart({
  data,
  nameKey,
  valueKey,
  label,
  format = "number",
  currency = "USD",
}: {
  data: Record<string, unknown>[];
  nameKey: string;
  valueKey: string;
  label: string;
  format?: ValueFormat;
  currency?: string;
}) {
  const height = Math.max(120, data.length * 34 + 24);
  return (
    <div style={{ height }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 56, left: 0, bottom: 4 }} barCategoryGap={8}>
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmt(v, format, currency, true)} />
          <YAxis type="category" dataKey={nameKey} tick={AXIS} tickLine={false} axisLine={false} width={120} tickFormatter={(v: string) => (v.length > 18 ? `${v.slice(0, 17)}…` : v)} />
          <Tooltip {...tooltipStyle()} cursor={{ fill: "var(--muted)" }} formatter={(v) => [fmt(Number(v), format, currency), label]} />
          <Bar dataKey={valueKey} fill={SERIES[0]} maxBarSize={22} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Stacked daily runs: succeeded / failed / other, status colors with a 2px surface gap. */
export function RunsTrendChart({ data, height = 240 }: { data: { day: string; succeeded: number; failed: number; other: number }[]; height?: number }) {
  const rows = data.map((d) => ({ ...d, label: d.day.slice(5) }));
  return (
    <div style={{ height }} role="img" aria-label="Workflow runs per day by outcome">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }} barCategoryGap="30%">
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
          <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
          <Tooltip {...tooltipStyle()} cursor={{ fill: "var(--muted)" }} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: "var(--muted-foreground)" }} />
          <Bar dataKey="succeeded" name="Succeeded" stackId="a" fill="#16a34a" stroke="var(--card)" strokeWidth={2} maxBarSize={24} />
          <Bar dataKey="failed" name="Failed" stackId="a" fill="#dc2626" stroke="var(--card)" strokeWidth={2} maxBarSize={24} />
          <Bar dataKey="other" name="In progress / review" stackId="a" fill="#94a3b8" stroke="var(--card)" strokeWidth={2} maxBarSize={24} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Column per pipeline stage (deal count), value in tooltip. */
export function PipelineChart({ data, currency, height = 240 }: { data: { stage: string; count: number; value: number }[]; currency: string; height?: number }) {
  const rows = data.map((d) => ({ ...d, label: d.stage[0].toUpperCase() + d.stage.slice(1) }));
  return (
    <div style={{ height }} role="img" aria-label="Deals per pipeline stage">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} interval={0} />
          <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
          <Tooltip
            {...tooltipStyle()}
            cursor={{ fill: "var(--muted)" }}
            formatter={(v, _n, item) => [`${v} deal(s) · ${formatCurrency((item.payload as { value: number }).value, currency)}`, "Stage"]}
          />
          <Bar dataKey="count" maxBarSize={24} radius={[4, 4, 0, 0]}>
            {rows.map((r) => (
              <Cell key={r.stage} fill={r.stage === "won" ? "#16a34a" : r.stage === "lost" ? "#94a3b8" : SERIES[0]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Two-series grouped columns (e.g. income vs expense per month). */
export function GroupedColumnsChart({
  data,
  xKey,
  series,
  currency,
  height = 260,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  series: { key: string; label: string }[];
  currency: string;
  height?: number;
}) {
  return (
    <div style={{ height }} role="img" aria-label={series.map((s) => s.label).join(" and ")}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => formatCurrency(v, currency, true)} />
          <Tooltip {...tooltipStyle()} cursor={{ fill: "var(--muted)" }} formatter={(v, name) => [formatCurrency(Number(v), currency), String(name)]} />
          {series.length > 1 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: "var(--muted-foreground)" }} />}
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={SERIES[i]} maxBarSize={22} radius={[4, 4, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
