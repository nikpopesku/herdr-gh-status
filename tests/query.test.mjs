import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQuery, isRateLimit, parse, parseRollup, parseRuns } from "../mods/gh-status/query.js";

const run = (id, name) => ({ databaseId: id, url: `https://github.com/o/r/actions/runs/${id}`, workflow: { name } });
const check = (name, status, conclusion, wr) => ({
  __typename: "CheckRun", name, status, conclusion, detailsUrl: `https://example.test/${name}`, checkSuite: { workflowRun: wr },
});

test("buildQuery adds an alias per valid repo and drops unsafe names", () => {
  const q = buildQuery(["o/a", "o/b", "bad repo/x", "o/c/d", "o/inj\"ect"]);
  assert.match(q, /r0: repository\(owner: "o", name: "a"\)/);
  assert.match(q, /r1: repository\(owner: "o", name: "b"\)/);
  assert.doesNotMatch(q, /r2:/);
  assert.match(q, /author:@me/);
});

test("parseRollup groups checks by workflow run and counts progress", () => {
  const r = parseRollup({ state: "PENDING", contexts: { nodes: [
    check("unit", "COMPLETED", "SUCCESS", run(1, "CI")),
    check("lint", "IN_PROGRESS", null, run(1, "CI")),
    check("deploy", "COMPLETED", "FAILURE", run(2, "Deploy")),
    { __typename: "StatusContext", context: "ci/other", state: "SUCCESS", targetUrl: "https://example.test/s" },
  ] } });
  assert.equal(r.runs.length, 3);
  const ci = r.runs.find((x) => x.name === "CI");
  assert.deepEqual([ci.state, ci.done, ci.total], ["running", 1, 2]);
  assert.equal(r.runs.find((x) => x.name === "Deploy").state, "failed");
  assert.equal(r.runs.find((x) => x.name === "ci/other").state, "passed");
  assert.equal(r.runs[0].state, "running", "running runs sort first");
});

test("parseRollup handles a missing rollup", () => {
  assert.deepEqual(parseRollup(null), { state: "NONE", runs: [], done: 0, total: 0 });
});

test("skipped and cancelled checks are neutral, not failures", () => {
  const r = parseRollup({ state: "SUCCESS", contexts: { nodes: [check("a", "COMPLETED", "SKIPPED", run(3, "W")), check("b", "COMPLETED", "CANCELLED", run(4, "X"))] } });
  assert.deepEqual(r.runs.map((x) => x.state), ["neutral", "neutral"]);
});

test("parse maps PRs and default branches", () => {
  const data = {
    rateLimit: { remaining: 4900, resetAt: "2026-01-01T00:00:00Z" },
    prs: { nodes: [
      { number: 7, title: "T", url: "u", isDraft: true, updatedAt: "x", reviewDecision: "APPROVED", mergeable: "CONFLICTING",
        repository: { nameWithOwner: "o/r" },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [check("t", "COMPLETED", "SUCCESS", run(9, "CI"))] } } } }] } },
      {},
    ] },
    r0: { nameWithOwner: "o/r", defaultBranchRef: { name: "main", target: { oid: "abcdef123456", messageHeadline: "msg", statusCheckRollup: null } } },
    r1: { nameWithOwner: "o/empty", defaultBranchRef: null },
  };
  const m = parse(data);
  assert.equal(m.prs.length, 1, "empty search nodes are dropped");
  assert.deepEqual([m.prs[0].repo, m.prs[0].number, m.prs[0].draft, m.prs[0].conflict, m.prs[0].review], ["o/r", 7, true, true, "APPROVED"]);
  assert.deepEqual(m.branches.map((b) => [b.repo, b.branch, b.oid]), [["o/r", "main", "abcdef1"]]);
  assert.equal(m.rate.remaining, 4900);
});

test("parse copes with no PRs", () => {
  assert.deepEqual(parse({ prs: { nodes: [] } }), { prs: [], branches: [], rate: null });
});

test("parseRuns maps REST workflow runs", () => {
  const runs = parseRuns("o/r", { workflow_runs: [
    { id: 1, name: "staging_deploy", status: "in_progress", conclusion: null, head_branch: "master", event: "push", html_url: "u", run_started_at: "2026-01-01T00:00:00Z" },
    { id: 2, name: "test", status: "completed", conclusion: "failure", head_branch: "x", event: "pull_request", html_url: "u2", created_at: "2026-01-01T00:00:00Z" },
  ] });
  assert.deepEqual(runs.map((r) => r.state), ["running", "failed"]);
  assert.equal(runs[0].repo, "o/r");
  assert.deepEqual(parseRuns("o/r", {}), []);
});

test("isRateLimit recognises primary and secondary limits", () => {
  assert.ok(isRateLimit("HTTP 403: API rate limit exceeded"));
  assert.ok(isRateLimit("You have exceeded a secondary rate limit"));
  assert.ok(!isRateLimit("HTTP 404: Not Found"));
  assert.ok(!isRateLimit(undefined));
});
