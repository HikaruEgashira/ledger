export type Kind = "review" | "authored";
export interface Card {
  kind?: Kind;
  url: string;
  repository: string;
  pr_number: number;
  status: string;
  priority: number | null;
  title: string | null;
  author: string | null;
  action: string | null;
  last_error: string | null;
  updated_at: string | null;
  added_at: string | null;
  approved_at: string | null;
  changes_requested_at: string | null;
  merged_at: string | null;
  completed_at: string | null;
  queue?: { state: "waiting" | "running" | "done" | "exhausted"; attempts: number; started_at: string | null; next_at: string | null } | null;
}
export type Unit = "day" | "week";
export type Stage = "done" | "merged" | "approved" | "added" | "responded" | "need_respond";
export type SeriesKey = "added" | "approved" | "merged" | "done";
export interface Bucket {
  start: Date;
  end: Date;
  label: string;
}
export interface Point extends Record<SeriesKey, number> {
  label: string;
  open: number;
  stage: Record<Stage, number>;
}

export const SERIES: [SeriesKey, string][] = [
  ["added", "--s1"],
  ["approved", "--s2"],
  ["merged", "--s3"],
  ["done", "--s4"],
];
export const STAGES: [Stage, string][] = [
  ["done", "--s4"],
  ["merged", "--s3"],
  ["approved", "--s2"],
  ["added", "--s1"],
  ["responded", "--s5"],
  ["need_respond", "--s6"],
];
export const RANGE: Record<Unit, number> = { day: 30, week: 12 };

export const doneAt = (r: Card): string | null =>
  r.completed_at || (r.status === "closed" ? r.updated_at : null);

// furthest stage reached before t; closed-without-merge counts as done
export function stageAt(r: Card, t: Date): Stage | null {
  const before = (v: string | null) => !!v && new Date(v) < t;
  if (!before(r.added_at)) return null;
  return before(doneAt(r))
    ? "done"
    : before(r.merged_at)
      ? "merged"
      : before(r.approved_at)
        ? "approved"
        : r.kind !== "authored"
          ? "added"
          : r.status === "mine_changes_requested"
            ? "need_respond"
            : "responded";
}
export function bucketStart(d: Date, unit: Unit): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  if (unit === "week") x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
export function buckets(unit: Unit, now = new Date()): Bucket[] {
  const out: Date[] = [];
  const cur = bucketStart(now, unit);
  for (let i = 0; i < RANGE[unit]; i++) {
    out.unshift(new Date(cur));
    cur.setDate(cur.getDate() - (unit === "week" ? 7 : 1));
  }
  return out.map((start, i, a) => {
    const end =
      i + 1 < a.length ? a[i + 1] : new Date(start.getTime() + (unit === "week" ? 7 : 1) * 864e5);
    return { start, end, label: `${start.getMonth() + 1}/${start.getDate()}` };
  });
}
export function aggregate(rows: Card[], unit: Unit, now = new Date()): Point[] {
  const inB = (t: string | null, b: Bucket) => !!t && new Date(t) >= b.start && new Date(t) < b.end;
  return buckets(unit, now).map((b) => ({
    label: b.label,
    added: rows.filter((r) => inB(r.added_at, b)).length,
    approved: rows.filter((r) => inB(r.approved_at, b)).length,
    merged: rows.filter((r) => inB(r.merged_at, b)).length,
    done: rows.filter((r) => inB(doneAt(r), b)).length,
    open: rows.filter(
      (r) =>
        r.added_at && new Date(r.added_at) < b.end && !(doneAt(r) && new Date(doneAt(r)!) < b.end),
    ).length,
    stage: Object.fromEntries(
      STAGES.map(([k]) => [k, rows.filter((r) => stageAt(r, b.end) === k).length]),
    ) as Record<Stage, number>,
  }));
}
export function niceMax(v: number): number {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return (Math.ceil((v / p) * 2) / 2) * p;
}
