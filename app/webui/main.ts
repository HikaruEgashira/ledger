import {
  aggregate,
  niceMax,
  SERIES,
  STAGES,
  type Card,
  type Point,
  type Unit,
} from "./dashboard.ts";
import { countErrors, filterLogs, groupLogs, inRange, type LevelFilter, type LogEntry, type Range } from "./logfilter.ts";

const COLUMNS = [
  ["queued", "--gray"],
  ["in_progress", "--blue"],
  ["reviewing", "--yellow"],
  ["waiting_ci", "--yellow"],
  ["changes_requested", "--red"],
  ["ready_to_approve", "--blue"],
  ["approval_pending_verification", "--blue"],
  ["approved", "--green"],
  ["human_required", "--red"],
  ["error", "--red"],
  ["merged_waiting_release", "--accent"],
  ["release_in_progress", "--accent"],
  ["post_release_monitoring", "--accent"],
  ["recovering", "--red"],
  ["recovered_monitoring", "--accent"],
  ["completed", "--green"],
  ["closed", "--gray"],
  ["mine_review_requested", "--yellow"],
  ["mine_changes_requested", "--red"],
  ["mine_ready_to_merge", "--green"],
];
const collapsed = new Set(["completed", "closed"]);
const kinds = new Set<string>(JSON.parse(localStorage.getItem("kinds") ?? '["review","authored"]'));
const state: { view: string; unit: Unit; author: string; level: LevelFilter; source: string; q: string; group: string; range: Range } = {
  view: ["#dash", "#log", "#decide"].includes(location.hash) ? location.hash.slice(1) : "board",
  unit: "day",
  author: "",
  level: "error",
  group: "on",
  range: "h",
  source: "",
  q: "",
};
let last: Card[] = [];
let logs: LogEntry[] = [];
const el = (tag: string, cls?: string | null, text?: string | number | null): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
};
const svgEl = (tag: string, attrs: Record<string, string | number>): SVGElement => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  return n;
};
const avatar = (login: string) => {
  const i = el("img", "avatar") as HTMLImageElement;
  i.src = `https://github.com/${encodeURIComponent(login)}.png?size=32`;
  i.alt = login;
  i.title = login;
  i.loading = "lazy";
  return i;
};
const tip = document.getElementById("tip")!;
function showTip(e: MouseEvent, title: string, rows: [string, string, number][]) {
  tip.replaceChildren(
    el("div", null, title),
    ...rows.map(([name, color, v]) => {
      const d = el("div");
      const sw = el("span", "sw");
      sw.style.background = `var(${color})`;
      d.append(sw, el("span", null, name), el("b", null, v));
      return d;
    }),
  );
  tip.style.display = "block";
  tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px";
  tip.style.top = e.clientY + 12 + "px";
}
const hideTip = () => {
  tip.style.display = "none";
};

const column = (r: Card) => (r.queue?.state === "running" ? "in_progress" : r.status);
const ago = (iso: string | null) => (iso ? `${Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))}m` : "");
function queueTag(r: Card): HTMLElement | null {
  const q = r.queue;
  if (!q) return null;
  if (q.state === "running") return el("span", "tag run", `running ${ago(q.started_at)} · ${q.attempts}/3`);
  if (q.state === "done") return el("span", "tag", "reviewed · waiting for PR change");
  if (q.state === "exhausted") return el("span", "tag err", `retry exhausted ${q.attempts}/3`);
  if (q.attempts > 0 && q.next_at) return el("span", "tag warn", `retry ${q.attempts}/3 @ ${fmtJst(q.next_at).slice(11, 16)}`);
  return el("span", "tag", "waiting");
}
function renderBoard(rows: Card[]) {
  const known = new Set(COLUMNS.map((c) => c[0]));
  const extra = [...new Set(rows.map(column).filter((s) => !known.has(s)))].map((s) => [
    s,
    "--gray",
  ]);
  document.getElementById("board")!.replaceChildren(
    ...[...COLUMNS, ...extra].map(([status, color]) => {
      const items = rows
        .filter((r) => column(r) === status)
        .sort(
          (a, b) =>
            (b.priority ?? 0) - (a.priority ?? 0) ||
            (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
        );
      const col = el(
        "section",
        "col" + (items.length ? "" : " empty") + (collapsed.has(status) ? " collapsed" : ""),
      );
      const head = el("header");
      const dot = el("span", "dot");
      dot.style.color = `var(${color})`;
      head.onclick = () => {
        if (!collapsed.delete(status)) collapsed.add(status);
        render();
      };
      head.append(dot, el("span", "name", status), el("span", "count", items.length));
      const list = el("div", "cards");
      if (!collapsed.has(status))
        for (const r of items) {
          const card = el("a", "card" + (r.queue?.state === "running" ? " running" : "") + (r.kind === "authored" ? " mine" : "")) as HTMLAnchorElement;
          card.href = r.url;
          card.target = "_blank";
          card.rel = "noopener noreferrer";
          const meta = el("div", "meta");
          meta.append(el("span", "ref", `${r.repository.split("/")[1]}#${r.pr_number}`));
          if (r.author) meta.append(avatar(r.author));
          card.append(meta, el("div", "title", r.title ?? ""));
          const tags = el("div", "tags");
          const qt = queueTag(r);
          if (qt) tags.append(qt);
          if (r.action) tags.append(el("span", "tag", r.action));
          if (r.last_error) {
            const t = el("span", "tag err", "!");
            t.title = r.last_error;
            tags.append(t);
          }
          if (tags.childElementCount) card.append(tags);
          list.append(card);
        }
      col.append(head, list);
      return col;
    }),
  );
}

function frame(data: Point[], max: number, H: number) {
  const W = 960,
    L = 32,
    B = 20,
    svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}` });
  const y = (v: number) => H - B - (v / max) * (H - B - 8);
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    svg.append(svgEl("line", { class: "grid", x1: L, x2: W, y1: y(v), y2: y(v) }));
    const t = svgEl("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" });
    t.textContent = String(Math.round(v));
    svg.append(t);
  }
  const step = (W - L) / data.length,
    cx = (i: number) => L + step * (i + 0.5);
  const every = Math.ceil(data.length / 12);
  data.forEach((d, i) => {
    if (i % every) return;
    const t = svgEl("text", { x: cx(i), y: H - 4, "text-anchor": "middle" });
    t.textContent = d.label;
    svg.append(t);
  });
  return { svg, y, step, cx, L, W, H, B };
}
function flow(data: Point[]) {
  const total = (d: Point) => STAGES.reduce((a, [k]) => a + d.stage[k], 0);
  const f = frame(data, niceMax(Math.max(1, ...data.map(total))), 260);
  const tops = data.map((d) => {
    let acc = 0;
    return STAGES.map(([k]) => (acc += d.stage[k]));
  });
  STAGES.forEach(([, c], j) => {
    const upper = data.map((d, i) => `${f.cx(i)},${f.y(tops[i][j])}`);
    const lower = data.map((d, i) => `${f.cx(i)},${f.y(j ? tops[i][j - 1] : 0)}`).reverse();
    f.svg.append(
      svgEl("polygon", {
        points: [...upper, ...lower].join(" "),
        fill: `var(${c})`,
        "fill-opacity": 0.85,
      }),
    );
  });
  f.svg.append(
    svgEl("polyline", {
      points: data.map((d, i) => `${f.cx(i)},${f.y(d.open)}`).join(" "),
      fill: "none",
      stroke: "var(--text)",
      "stroke-width": 2,
      "stroke-dasharray": "4 3",
    }),
  );
  const cross = svgEl("line", {
    x1: 0,
    x2: 0,
    y1: 8,
    y2: f.H - f.B,
    stroke: "var(--faint)",
    "stroke-width": 1,
    visibility: "hidden",
  });
  f.svg.append(cross);
  data.forEach((d, i) => {
    const hit = svgEl("rect", {
      x: f.cx(i) - f.step / 2,
      y: 0,
      width: f.step,
      height: f.H - f.B,
      fill: "transparent",
    });
    hit.onmousemove = (e) => {
      cross.setAttribute("x1", String(f.cx(i)));
      cross.setAttribute("x2", String(f.cx(i)));
      cross.setAttribute("visibility", "visible");
      showTip(e, d.label, [
        ["open", "--text", d.open],
        ...[...STAGES].reverse().map(([k, c]): [string, string, number] => [k, c, d.stage[k]]),
      ]);
    };
    hit.onmouseleave = () => {
      cross.setAttribute("visibility", "hidden");
      hideTip();
    };
    f.svg.append(hit);
  });
  return f.svg;
}
function legend(series: [string, string][]) {
  const l = el("span", "legend");
  for (const [k, c] of series) {
    const s = el("span");
    const sw = el("span", "sw");
    sw.style.background = `var(${c})`;
    s.append(sw, k);
    l.append(s);
  }
  return l;
}
function renderDash(rows: Card[]) {
  const data = aggregate(rows, state.unit);
  const p1 = el("div", "panel");
  const h1 = el("h2", null, "cumulative flow");
  h1.append(legend([...[...STAGES].reverse(), ["open", "--text"]]));
  p1.append(h1, flow(data));
  const p3 = el("div", "panel");
  const table = el("table");
  const hr = el("tr");
  for (const k of ["", "open", ...SERIES.map((s) => s[0])]) hr.append(el("th", null, k));
  table.append(hr);
  for (const d of [...data].reverse()) {
    const tr = el("tr");
    for (const k of ["label", "open", ...SERIES.map((s) => s[0])] as const)
      tr.append(el("td", null, d[k]));
    table.append(tr);
  }
  p3.append(table);
  document.getElementById("dash")!.replaceChildren(p1, p3);
}

function syncAuthors(rows: Card[]) {
  const sel = document.getElementById("author") as HTMLSelectElement;
  const names = [...new Set(rows.map((r) => r.author).filter((a): a is string => !!a))].sort();
  if (sel.options.length - 1 === names.length) return;
  sel.replaceChildren(new Option("author", ""), ...names.map((n) => new Option(n, n)));
  sel.value = state.author;
}
const JST = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const fmtJst = (ts: string | null) => (ts && !Number.isNaN(Date.parse(ts)) ? JST.format(new Date(ts)) : ts ?? "");
function renderLog() {
  const filtered = filterLogs(logs, state);
  const rows = state.group === "on" ? groupLogs(filtered) : filtered.map((e) => ({ ...e, count: 1, urls: e.url ? [e.url] : [] }));
  const table = el("table");
  const hr = el("tr");
  for (const k of ["level", "source", "count", "latest (JST)", "PR", "message"]) hr.append(el("th", null, k));
  table.append(hr);
  for (const e of rows.slice(0, 500)) {
    const tr = el("tr", e.level);
    tr.append(el("td", "nowrap lv", e.level), el("td", "nowrap", e.source), el("td", "nowrap", e.count), el("td", "nowrap", fmtJst(e.ts)));
    const pr = el("td", "nowrap");
    for (const u of e.urls.slice(0, 5)) {
      const a = el("a", null, u.replace(/^https:\/\/github\.com\/[^/]+\//, "")) as HTMLAnchorElement;
      a.href = u;
      a.target = "_blank";
      a.rel = "noopener";
      a.style.color = "var(--blue)";
      a.style.display = "block";
      pr.append(a);
    }
    if (e.urls.length > 5) pr.append(el("div", null, `+${e.urls.length - 5}`));
    tr.append(pr, el("td", "msg", e.msg.length > 1200 ? e.msg.slice(0, 1200) + "…" : e.msg));
    table.append(tr);
  }
  const note = el("div", null, `${rows.length} rows (${filtered.length} / ${logs.length} entries)`);
  note.style.color = "var(--faint)";
  note.style.marginBottom = "8px";
  document.getElementById("log")!.replaceChildren(note, table);
}
function syncSources() {
  const sel = document.getElementById("source") as HTMLSelectElement;
  const names = [...new Set(logs.map((e) => e.source))].sort();
  if (sel.options.length - 1 === names.length) return;
  sel.replaceChildren(new Option("source", ""), ...names.map((n) => new Option(n, n)));
  sel.value = state.source;
}
interface Pending {
  url: string;
  repository: string;
  pr_number: number;
  title: string;
  reason: string;
  head: string;
  question: string;
  options: string[];
  asked_at: string;
  held: boolean;
}
let pending: Pending[] = [];
const FIXED: Record<string, string> = { "PRをclose": "danger", "保留": "mute", "自動対応で再試行": "mute" };
async function answer(p: Pending, choice: string, card: HTMLElement, custom = false) {
  if (!custom && choice === "PRをclose" && !confirm(`${p.repository}#${p.pr_number} を close します`)) return;
  card.style.pointerEvents = "none";
  const res = await fetch("/api/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: p.url, head: p.head, choice, custom }),
  });
  if (!res.ok) {
    alert(await res.text());
    card.style.pointerEvents = "";
  }
  await refreshDecisions();
}
function renderDecide() {
  const root = document.getElementById("decide")!;
  if (!pending.length) return root.replaceChildren(el("div", "meta", "判断待ちはありません"));
  root.replaceChildren(
    ...pending.map((p) => {
      const card = el("div", p.held ? "q held" : "q");
      const meta = el("div", "meta");
      const a = el("a", null, `${p.repository}#${p.pr_number}`) as HTMLAnchorElement;
      a.href = p.url;
      a.target = "_blank";
      a.rel = "noopener";
      meta.append(a, ` · ${p.reason} · ${fmtJst(p.asked_at)}${p.held ? " · 保留中" : ""} · ${p.title}`);
      const opts = el("div", "opts");
      for (const o of p.options) {
        const b = el("button", FIXED[o] ?? null, o);
        b.onclick = () => void answer(p, o, card);
        opts.append(b);
      }
      const free = el("input", "free") as HTMLInputElement;
      free.placeholder = "自由記述（Enter で送信）";
      free.maxLength = 2000;
      free.onkeydown = (e) => {
        if (e.key === "Enter" && !e.isComposing && free.value.trim()) void answer(p, free.value, card, true);
      };
      opts.append(free);
      card.append(meta, el("div", "ask", p.question), opts);
      return card;
    }),
  );
}
async function refreshDecisions() {
  try {
    const res = await fetch("/api/decisions", { cache: "no-store" });
    if (res.ok) {
      pending = await res.json();
      render();
    }
  } catch {}
}
function render() {
  document.body.classList.toggle("dash", state.view === "dash");
  document.body.classList.toggle("log", state.view === "log");
  document.body.classList.toggle("decide", state.view === "decide");
  const open = pending.filter((p) => !p.held).length;
  const dbadge = document.getElementById("decidecount")!;
  dbadge.hidden = open === 0;
  dbadge.textContent = String(open);
  const n = countErrors(logs.filter((e) => inRange(e, state.range)));
  const badge = document.getElementById("errcount")!;
  badge.hidden = n === 0;
  badge.textContent = String(n);
  for (const id of ["view", "unit", "level", "group", "range"] as const)
    for (const b of document.getElementById(id)!.children as HTMLCollectionOf<HTMLElement>)
      b.classList.toggle("on", b.dataset.v === state[id]);
  for (const b of document.querySelectorAll<HTMLInputElement>("#kind input")) b.checked = kinds.has(b.value);
  const rows = last.filter((r) => kinds.has(r.kind ?? "review") && (!state.author || r.author === state.author));
  if (state.view === "dash") renderDash(rows);
  else if (state.view === "log") renderLog();
  else if (state.view === "decide") renderDecide();
  else renderBoard(rows);
}
for (const id of ["view", "unit", "level", "group", "range"] as const)
  document.getElementById(id)!.onclick = (e) => {
    const v = (e.target as HTMLElement).closest<HTMLElement>("[data-v]")?.dataset.v;
    if (!v) return;
    if (id === "unit") state.unit = v as Unit;
    else if (id === "level") state.level = v as LevelFilter;
    else if (id === "group") state.group = v;
    else if (id === "range") state.range = v as Range;
    else state.view = v;
    if (id === "view") history.replaceState(null, "", state.view === "board" ? "#" : `#${state.view}`);
    render();
  };
document.getElementById("source")!.onchange = (e) => {
  state.source = (e.target as HTMLSelectElement).value;
  render();
};
document.getElementById("q")!.oninput = (e) => {
  state.q = (e.target as HTMLInputElement).value;
  render();
};
document.getElementById("kind")!.onchange = (e) => {
  const b = e.target as HTMLInputElement;
  if (b.checked) kinds.add(b.value);
  else kinds.delete(b.value);
  localStorage.setItem("kinds", JSON.stringify([...kinds]));
  render();
};
document.getElementById("author")!.onchange = (e) => {
  state.author = (e.target as HTMLSelectElement).value;
  render();
};
async function refresh() {
  try {
    const res = await fetch("/api/rows", { cache: "no-store" });
    if (res.ok) {
      last = await res.json();
      syncAuthors(last);
      render();
    }
  } catch {}
}
async function refreshLogs() {
  try {
    const res = await fetch("/api/logs", { cache: "no-store" });
    if (res.ok) {
      logs = await res.json();
      syncSources();
      render();
    }
  } catch {}
}
new EventSource("/api/events").onmessage = () => {
  void refresh();
  void refreshLogs();
  void refreshDecisions();
};
setInterval(refreshLogs, 30_000);
