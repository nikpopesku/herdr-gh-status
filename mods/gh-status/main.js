import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, window, checking, props as getProps } from "herdr";
import { buildQuery, parse, parseRuns, isRateLimit } from "./query.js";

const MIN = 5, BUSY = 10, IDLE = 30, MAX = 900, RATE_MIN = 180; // seconds
const RUNS_BUSY = 60, RUNS_IDLE = 300; // Actions REST endpoint: gentler
const short = (repo) => repo.split("/")[1];
const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };

export default class GhStatus extends View {
  init(_props, cx) {
    const props = getProps() ?? {}; // props come from the layout block via props(), not the init argument
    this.fixed = Number(props?.poll_seconds) > 0 ? Math.max(MIN, Number(props.poll_seconds)) : 0; // 0 = adaptive
    this.extra = Array.isArray(props?.repos) ? props.repos : [];
    this.delay = this.fixed || IDLE; this.nextAt = 0;
    this.runs = null; this.runsError = null; this.runsAt = 0; this.runsNext = 0; this.runsBusy = false; this.runsDelay = RUNS_IDLE;
    try { this.hidden = new Set(JSON.parse(localStorage.getItem("gh-status.hidden") ?? "[]")); } catch { this.hidden = new Set(); } this.data = null; this.error = null; this.okAt = 0;
    this.open = new Set(); this.busy = false; this.lastManual = 0; this.ticks = 0; this.sig = "";
    if (checking()) return; // `herdr-app check` must not call GitHub
    cx.timer.every(5000, (cx) => this.tick(cx));
    this.tick(cx);
  }

  tick(cx) {
    this.ticks++;
    const due = !this.busy && Date.now() >= this.nextAt && window()?.visible !== false;
    const runsDue = window()?.visible !== false && !this.hidden.has("actions") && !this.runsBusy && Date.now() >= this.runsNext && this.data;
    if (runsDue) this.refreshRuns(cx);
    if (due) this.refresh(cx);
    else if (this.ticks % 3 === 0) cx.notify(); // keep "updated Ns ago" fresh, cheaply
  }

  refresh(cx, manual = false) {
    if (this.busy) return;
    this.busy = true; if (manual) cx.notify(); // routine polls redraw only if something changed
    const hadError = this.error;
    cx.spawn(async (cx) => {
      let wait = this.delay;
      try {
        const repos = [...new Set([...(this.data?.prs ?? []).map((p) => p.repo), ...this.extra])];
        const r = await exec("gh", ["api", "graphql", "-f", `query=${buildQuery(repos)}`], { timeout: 20000 });
        if (r.code !== 0) throw Object.assign(new Error((r.stderr || r.stdout).trim()), { limited: isRateLimit(r.stderr + r.stdout) });
        const json = JSON.parse(r.stdout);
        if (json.errors?.length && !json.data) throw Object.assign(new Error(json.errors[0].message), { limited: isRateLimit(json.errors[0].message) });
        const next = parse(json.data), sig = JSON.stringify([next.prs, next.branches]);
        if (sig !== this.sig) { this.sig = sig; this.changed = true; }
        this.data = next; this.okAt = Date.now(); this.error = null;
        const busy = [...next.prs, ...next.branches].some((i) => i.runs.some((r) => r.state === "running"));
        this.delay = this.fixed || (busy ? BUSY : IDLE); wait = this.delay;
        if (busy && !this.wasBusy) this.runsNext = 0; // a check just started: look at Actions now, not in 5 minutes
        this.wasBusy = busy;
        if (this.data.rate?.remaining === 0) wait = Math.max(wait, (Date.parse(this.data.rate.resetAt) - Date.now()) / 1000);
      } catch (e) {
        const msg = String(e.message || e);
        const login = /auth login|not logged|gh auth|authentication/i.test(msg);
        const missing = /ENOENT|not found|No such file/i.test(msg) && !login;
        this.error = login ? "gh is not logged in: run `gh auth login`" : missing ? "gh (GitHub CLI) was not found" : e.limited ? "GitHub rate limit: backing off" : msg.split("\n")[0].slice(0, 120);
        this.delay = Math.min(MAX, Math.max(this.delay, MIN) * 2);
        wait = e.limited ? Math.max(RATE_MIN, this.delay) : this.delay;
      }
      this.nextAt = Date.now() + wait * 1000; this.retry = wait;
      this.busy = false;
      if (this.changed || manual || hadError !== this.error) cx.notify();
      this.changed = false;
    });
  }

  repoList() { return [...new Set([...(this.data?.prs ?? []).map((p) => p.repo), ...this.extra])].filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)); }

  refreshRuns(cx) {
    this.runsBusy = true;
    cx.spawn(async (cx) => {
      let wait = RUNS_IDLE;
      try {
        const all = [];
        for (const repo of this.repoList()) { // one at a time, never in parallel
          const r = await exec("gh", ["api", `repos/${repo}/actions/runs?per_page=8`], { timeout: 20000 });
          if (r.code !== 0) throw Object.assign(new Error((r.stderr || r.stdout).trim()), { limited: isRateLimit(r.stderr + r.stdout) });
          const runs = parseRuns(repo, JSON.parse(r.stdout));
          for (const run of runs.filter((x) => x.state === "running").slice(0, 3)) {
            const j = await exec("gh", ["api", `repos/${repo}/actions/runs/${run.id}/jobs?per_page=50`], { timeout: 20000 });
            if (j.code === 0) { const jobs = JSON.parse(j.stdout).jobs ?? []; run.total = jobs.length; run.done = jobs.filter((x) => x.status === "completed").length; }
          }
          all.push(...runs);
        }
        all.sort((a, b) => (a.state === "running" ? 0 : 1) - (b.state === "running" ? 0 : 1) || b.at - a.at);
        this.runs = all.slice(0, 15); this.runsError = null; this.runsAt = Date.now();
        this.runsDelay = this.runs.some((r) => r.state === "running") ? RUNS_BUSY : RUNS_IDLE; wait = this.runsDelay;
      } catch (e) {
        this.runsError = e.limited ? "rate limited" : String(e.message || e).split("\n")[0].slice(0, 80);
        this.runsDelay = Math.min(MAX, this.runsDelay * 2); wait = e.limited ? Math.max(RATE_MIN, this.runsDelay) : this.runsDelay;
      }
      this.runsNext = Date.now() + wait * 1000; this.runsBusy = false; cx.notify();
    });
  }

  toggle(name, cx) {
    this.hidden.has(name) ? this.hidden.delete(name) : this.hidden.add(name);
    try { localStorage.setItem("gh-status.hidden", JSON.stringify([...this.hidden])); } catch {}
    if (name === "actions" && !this.hidden.has(name)) this.runsNext = 0; // fetch when shown again
    cx.notify();
  }

  openUrl(url, cx) { if (url) cx.spawn(async () => { await exec("xdg-open", [url]); }); }

  color(t, state) { return state === "failed" ? t.ansi1 : state === "passed" ? t.ansi2 : state === "running" ? t.working : t.dim; }

  icon(t, state, size = 12) {
    if (state === "running") return svg("mods/gh-status/spinner.svg").size(size).text_color(t.working).spin(900);
    const glyph = state === "passed" ? "✓" : state === "failed" ? "✕" : "–";
    return div().w(size).flex_none().text_size(size).text_color(this.color(t, state)).child(glyph);
  }

  summaryState(item) {
    if (item.runs.some((r) => r.state === "running")) return "running";
    if (item.runs.some((r) => r.state === "failed")) return "failed";
    return item.total ? "passed" : "neutral";
  }

  reviewLabel(p) {
    return p.review === "APPROVED" ? "approved" : p.review === "CHANGES_REQUESTED" ? "changes requested" : p.review === "REVIEW_REQUIRED" ? "review required" : "no review";
  }

  header(t, cx) {
    const status = this.error ? `${this.error}${this.retry ? ` · retry ${ago(this.retry * 1000)}` : ""}`
      : this.okAt ? `updated ${ago(Date.now() - this.okAt)} ago` : "loading…";
    return h_flex().h(36).px(12).gap(8).items_center().flex_none().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("GitHub"))
      .child(div().flex_1().truncate().text_size(11).text_color(this.error ? t.ansi1 : t.dim).child(status))
      .child(this.busy ? svg("mods/gh-status/spinner.svg").size(13).text_color(t.dim).spin(900)
        : div().id("gh-refresh").px(6).text_color(t.muted).hover((s) => s.bg(t.hover)).rounded(5)
          .on_click((_e, cx) => { if (Date.now() - this.lastManual > 15000) { this.lastManual = Date.now(); this.refresh(cx, true); } }).child("⟳"));
  }

  section(t, key, title, count) {
    return h_flex().id(`sec-${key}`).px(12).pt(10).pb(4).gap(6).text_size(10.5).font_semibold().text_color(t.dim)
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.toggle(key, cx))
      .child(this.hidden.has(key) ? "▸" : "▾").child(title.toUpperCase()).child(String(count));
  }

  runItem(t, r) {
    const info = r.state === "running" && r.total ? `${r.done}/${r.total}` : ago(Date.now() - r.at);
    return h_flex().id(`run-${r.repo}-${r.id}`).px(12).py(4).gap(8).items_center().text_size(12).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openUrl(r.url, cx))
      .child(this.icon(t, r.state, 12))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().child(r.name))
        .child(div().text_size(11).text_color(t.dim).truncate().child(`${short(r.repo)} · ${r.branch}${r.event && r.event !== "push" ? ` · ${r.event.replace(/_/g, " ")}` : ""}`)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(info));
  }

  runRows(t, item, id) {
    return item.runs.map((r, i) => v_flex().child(
      h_flex().id(`${id}-run-${i}`).pl(30).pr(12).py(2).gap(6).items_center().text_size(11.5).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.openUrl(r.url, cx))
        .child(this.icon(t, r.state, 11))
        .child(div().flex_1().truncate().text_color(t.muted).child(r.name))
        .child(div().text_color(t.dim).child(r.state === "running" ? `${r.done}/${r.total}` : `${r.total}`)))
      .children(r.state === "passed" || r.total < 2 ? [] : r.jobs.filter((j) => j.state !== "passed").map((j, k) =>
        h_flex().id(`${id}-job-${i}-${k}`).pl(48).pr(12).py(1).gap(6).items_center().text_size(11).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.openUrl(j.url, cx))
          .child(this.icon(t, j.state, 10)).child(div().flex_1().truncate().text_color(t.dim).child(j.name)))));
  }

  row(t, id, title, sub, item, url) {
    const state = this.summaryState(item), expanded = this.open.has(id);
    const running = item.runs.filter((r) => r.state === "running");
    const detail = running.length ? `${running.length === 1 ? running[0].name : `${running.length} runs`} ${running.reduce((s, r) => s + r.done, 0)}/${running.reduce((s, r) => s + r.total, 0)}`
      : item.total ? `checks ${item.runs.filter((r) => r.state === "passed").length}/${item.runs.length}` : "no checks";
    return v_flex().child(
      h_flex().id(id).px(12).py(5).gap(8).items_start().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { expanded ? this.open.delete(id) : this.open.add(id); cx.notify(); })
        .on_mouse_down("right", (_e, cx) => this.openUrl(url, cx))
        .child(div().pt(2).child(this.icon(t, state, 13)))
        .child(v_flex().flex_1().min_w(0)
          .child(h_flex().gap(6).text_size(12.5).child(div().flex_none().text_color(t.dim).child(title)).child(div().flex_1().truncate().child(sub)))
          .child(div().text_size(11).text_color(t.dim).truncate().child(item.extra ? `${detail} · ${item.extra}` : detail))))
      .children(expanded ? this.runRows(t, item, id) : []);
  }

  render(cx) {
    const t = theme(), d = this.data;
    const prs = (d?.prs ?? []).map((p) => {
      const bits = [this.reviewLabel(p), p.draft && "draft", p.conflict && "conflict"].filter(Boolean);
      return this.row(t, `pr-${p.repo}-${p.number}`, `${short(p.repo)} #${p.number}`, p.title, { ...p, extra: bits.join(" · ") }, p.url);
    });
    const branches = (d?.branches ?? []).map((b) => this.row(t, `br-${b.repo}`, `${short(b.repo)} ${b.branch}`, b.headline, { ...b, extra: b.oid }, `https://github.com/${b.repo}/actions`));
    const open = (k) => !this.hidden.has(k);
    const actions = open("actions") ? (this.runs ? (this.runs.length ? this.runs.map((r) => this.runItem(t, r)) : [div().px(12).py(4).text_size(12).text_color(t.dim).child("No runs.")])
      : [div().px(12).py(4).text_size(12).text_color(t.dim).child(this.runsError ?? "Loading…")]) : [];
    return v_flex().id("gh-root").size_full().bg(t.surface).text_color(t.foreground)
      .child(this.header(t, cx))
      .child(v_flex().id("gh-scroll").flex_1().overflow_y_scrollbar().pb(8)
        .child(this.section(t, "prs", "Pull requests", d ? d.prs.length : 0))
        .children(!open("prs") ? [] : d && !prs.length ? [div().px(12).py(4).text_size(12).text_color(t.dim).child("No open pull requests.")] : prs)
        .child(this.section(t, "actions", "Actions", this.runs?.length ?? 0))
        .children(this.runsError && this.runs && open("actions") ? [div().px(12).text_size(11).text_color(t.ansi1).child(`Actions: ${this.runsError}`)] : [])
        .children(actions)
        .children(branches.length ? [this.section(t, "branches", "Default branches", branches.length), ...(open("branches") ? branches : [])] : []));
  }
}
