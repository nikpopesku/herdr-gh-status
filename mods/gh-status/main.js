import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, window, checking } from "herdr";
import { buildQuery, parse, isRateLimit } from "./query.js";

const MIN = 60, MAX = 900, RATE_MIN = 180; // seconds
const short = (repo) => repo.split("/")[1];
const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };

export default class GhStatus extends View {
  init(props, cx) {
    this.poll = Math.max(MIN, Number(props?.poll_seconds) || MIN);
    this.extra = Array.isArray(props?.repos) ? props.repos : [];
    this.delay = this.poll; this.nextAt = 0; this.data = null; this.error = null; this.okAt = 0;
    this.open = new Set(); this.busy = false; this.lastManual = 0; this.ticks = 0;
    if (checking()) return; // `herdr-app check` must not call GitHub
    cx.timer.every(5000, (cx) => this.tick(cx));
    this.tick(cx);
  }

  tick(cx) {
    this.ticks++;
    const due = !this.busy && Date.now() >= this.nextAt && window()?.visible !== false;
    if (due) this.refresh(cx);
    else if (this.ticks % 3 === 0) cx.notify(); // keep "updated Ns ago" fresh, cheaply
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      let wait = this.poll;
      try {
        const repos = [...new Set([...(this.data?.prs ?? []).map((p) => p.repo), ...this.extra])];
        const r = await exec("gh", ["api", "graphql", "-f", `query=${buildQuery(repos)}`], { timeout: 20000 });
        if (r.code !== 0) throw Object.assign(new Error((r.stderr || r.stdout).trim()), { limited: isRateLimit(r.stderr + r.stdout) });
        const json = JSON.parse(r.stdout);
        if (json.errors?.length && !json.data) throw Object.assign(new Error(json.errors[0].message), { limited: isRateLimit(json.errors[0].message) });
        this.data = parse(json.data); this.okAt = Date.now(); this.error = null; this.delay = this.poll; wait = this.poll;
        if (this.data.rate?.remaining === 0) wait = Math.max(wait, (Date.parse(this.data.rate.resetAt) - Date.now()) / 1000);
      } catch (e) {
        const msg = String(e.message || e);
        const login = /auth login|not logged|gh auth|authentication/i.test(msg);
        const missing = /ENOENT|not found|No such file/i.test(msg) && !login;
        this.error = login ? "gh is not logged in: run `gh auth login`" : missing ? "gh (GitHub CLI) was not found" : e.limited ? "GitHub rate limit: backing off" : msg.split("\n")[0].slice(0, 120);
        this.delay = Math.min(MAX, this.delay * 2);
        wait = e.limited ? Math.max(RATE_MIN, this.delay) : this.delay;
      }
      this.nextAt = Date.now() + wait * 1000; this.retry = wait;
      this.busy = false; cx.notify();
    });
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
          .on_click((_e, cx) => { if (Date.now() - this.lastManual > 15000) { this.lastManual = Date.now(); this.refresh(cx); } }).child("⟳"));
  }

  section(t, title, count) {
    return h_flex().px(12).pt(10).pb(4).gap(6).text_size(10.5).font_semibold().text_color(t.dim).child(title.toUpperCase()).child(String(count));
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
    return v_flex().id("gh-root").size_full().bg(t.surface).text_color(t.foreground)
      .child(this.header(t, cx))
      .child(v_flex().id("gh-scroll").flex_1().overflow_y_scrollbar().pb(8)
        .child(this.section(t, "Pull requests", d ? d.prs.length : 0))
        .children(d && !prs.length ? [div().px(12).py(4).text_size(12).text_color(t.dim).child("No open pull requests.")] : prs)
        .children(branches.length ? [this.section(t, "Default branches", branches.length), ...branches] : []));
  }
}
