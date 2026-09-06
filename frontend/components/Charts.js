/**
 * components/Charts.js
 * ------------------------------------------------------------------
 * Chart.js wrappers. The tree-shakeable registration happens once here
 * so individual pages can just render <StatusDonut data={...} />.
 *
 * All charts are 'use client' (Chart.js needs the DOM) and share one
 * consistent colour + font configuration.
 */

'use client';

import {
  Chart as ChartJS,
  ArcElement,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Doughnut, Line, Bar } from 'react-chartjs-2';

ChartJS.register(
  ArcElement,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler
);

/** Consistent tooltip / legend styling. */
const BASE_OPTIONS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      position: 'bottom',
      labels: { boxWidth: 10, boxHeight: 10, padding: 12, font: { size: 11 }, usePointStyle: true },
    },
    tooltip: {
      backgroundColor: '#0f172a',
      padding: 10,
      titleFont: { size: 12 },
      bodyFont: { size: 12 },
      cornerRadius: 8,
      displayColors: true,
      boxWidth: 8,
      boxHeight: 8,
    },
  },
};

/** Palette matched to the status badge colours. */
export const STATUS_COLORS = {
  applied: '#3b82f6',
  responded: '#a855f7',
  interview: '#eab308',
  offer: '#22c55e',
  rejected: '#ef4444',
  ghosted: '#94a3b8',
  withdrawn: '#f97316',
};

/** Empty-state placeholder shown instead of a blank chart. */
function Empty({ label }) {
  return <div className="flex h-full min-h-[180px] items-center justify-center text-xs text-slate-400">{label}</div>;
}

/* ------------------------------------------------------------------ *
 * Donut — application status breakdown (Dashboard)
 * ------------------------------------------------------------------ */

export function StatusDonut({ stats }) {
  const labels = [];
  const values = [];
  const colors = [];

  ['applied', 'responded', 'interview', 'offer', 'rejected', 'ghosted', 'withdrawn'].forEach((key) => {
    const n = stats?.[key] || 0;
    if (n > 0) {
      labels.push(key.charAt(0).toUpperCase() + key.slice(1));
      values.push(n);
      colors.push(STATUS_COLORS[key]);
    }
  });

  if (!values.length) return <Empty label="No applications yet" />;

  return (
    <Doughnut
      data={{
        labels,
        datasets: [
          {
            data: values,
            backgroundColor: colors,
            borderWidth: 2,
            borderColor: '#ffffff',
            hoverOffset: 6,
          },
        ],
      }}
      options={{
        ...BASE_OPTIONS,
        cutout: '62%',
        plugins: {
          ...BASE_OPTIONS.plugins,
          tooltip: {
            ...BASE_OPTIONS.plugins.tooltip,
            callbacks: {
              label: (ctx) => {
                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                const pct = total ? Math.round((ctx.parsed / total) * 100) : 0;
                return ` ${ctx.label}: ${ctx.parsed} (${pct}%)`;
              },
            },
          },
        },
      }}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Line — applications over the last 30 days (Tracker)
 * ------------------------------------------------------------------ */

export function ApplicationsLine({ series = [] }) {
  if (!series.length) return <Empty label="No data for the last 30 days" />;

  return (
    <Line
      data={{
        labels: series.map((s) => s.label),
        datasets: [
          {
            label: 'Applications',
            data: series.map((s) => s.count),
            borderColor: '#2563eb',
            backgroundColor: 'rgba(37, 99, 235, 0.12)',
            fill: true,
            tension: 0.35,
            pointRadius: 2,
            pointHoverRadius: 5,
            borderWidth: 2,
          },
        ],
      }}
      options={{
        ...BASE_OPTIONS,
        plugins: { ...BASE_OPTIONS.plugins, legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
          y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, grid: { color: '#f1f5f9' } },
        },
      }}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Bar — applications by source (Tracker)
 * ------------------------------------------------------------------ */

export function SourceBar({ bySource = {} }) {
  const entries = Object.entries(bySource).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <Empty label="No applications yet" />;

  const palette = ['#3b82f6', '#6366f1', '#10b981', '#f97316', '#14b8a6', '#a855f7', '#f43f5e'];

  return (
    <Bar
      data={{
        labels: entries.map(([k]) => k),
        datasets: [
          {
            label: 'Applications',
            data: entries.map(([, v]) => v),
            backgroundColor: entries.map((_, i) => palette[i % palette.length]),
            borderRadius: 6,
            maxBarThickness: 46,
          },
        ],
      }}
      options={{
        ...BASE_OPTIONS,
        plugins: { ...BASE_OPTIONS.plugins, legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 } } },
          y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, grid: { color: '#f1f5f9' } },
        },
      }}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Horizontal bar — skill gaps (Dashboard)
 * ------------------------------------------------------------------ */

export function SkillGapBar({ gaps = [] }) {
  if (!gaps.length) return <Empty label="No skill gaps detected — upload a resume and scrape some jobs" />;

  return (
    <Bar
      data={{
        labels: gaps.map((g) => g.skill),
        datasets: [
          {
            label: 'Jobs missing it',
            data: gaps.map((g) => g.count),
            backgroundColor: '#ef4444',
            borderRadius: 6,
            maxBarThickness: 20,
          },
        ],
      }}
      options={{
        ...BASE_OPTIONS,
        indexAxis: 'y',
        plugins: {
          ...BASE_OPTIONS.plugins,
          legend: { display: false },
          tooltip: {
            ...BASE_OPTIONS.plugins.tooltip,
            callbacks: {
              label: (ctx) => ` missing in ${ctx.parsed.x} job(s) — ${gaps[ctx.dataIndex].percentage}% of matches`,
            },
          },
        },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, grid: { color: '#f1f5f9' } },
          y: { grid: { display: false }, ticks: { font: { size: 11 } } },
        },
      }}
    />
  );
}
