// GraphQL text and parsing for the gh-status mod. No Herdr imports, so it is easy to test with node.

const SAFE = /^[A-Za-z0-9_.-]+$/;

const ROLLUP = `statusCheckRollup { state contexts(first: 100) { nodes { __typename
  ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { databaseId url workflow { name } } } }
  ... on StatusContext { context state targetUrl } } } }`;

/** One query: my open PRs plus the default-branch rollup of each repo in `repos` ("owner/name"). */
export function buildQuery(repos) {
  const branches = repos.filter((r) => { const [o, n, ...x] = r.split("/"); return !x.length && SAFE.test(o ?? "") && SAFE.test(n ?? ""); })
    .map((r, i) => { const [o, n] = r.split("/");
      return `r${i}: repository(owner: ${JSON.stringify(o)}, name: ${JSON.stringify(n)}) { nameWithOwner defaultBranchRef { name target { ... on Commit { oid messageHeadline ${ROLLUP} } } } }`; });
  return `query {
  rateLimit { remaining resetAt }
  prs: search(query: "is:pr is:open author:@me archived:false sort:updated-desc", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { number title url isDraft updatedAt reviewDecision mergeable
      repository { nameWithOwner }
      commits(last: 1) { nodes { commit { ${ROLLUP} } } } } }
  }
  ${branches.join("\n  ")}
}`;
}

const RUNNING = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "EXPECTED"]);
const BAD = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ERROR", "ACTION_REQUIRED"]);

/** "running" | "failed" | "passed" | "neutral" for one check run or status context. */
function jobState(status, conclusion) {
  if (status && status !== "COMPLETED") return RUNNING.has(status) ? "running" : "neutral";
  if (BAD.has(conclusion)) return "failed";
  if (conclusion === "SUCCESS") return "passed";
  return "neutral"; // skipped, cancelled, neutral, stale
}

/** Groups a rollup's checks by workflow run; checks without a run (other CI, statuses) group by name. */
export function parseRollup(rollup) {
  if (!rollup) return { state: "NONE", runs: [], done: 0, total: 0 };
  const groups = new Map();
  for (const c of rollup.contexts?.nodes ?? []) {
    let job, run;
    if (c.__typename === "CheckRun") {
      const wr = c.checkSuite?.workflowRun;
      job = { name: c.name, state: jobState(c.status, c.conclusion), url: c.detailsUrl };
      run = { key: wr ? `run:${wr.databaseId}` : `chk:${c.name}`, name: wr?.workflow?.name ?? c.name, url: wr?.url ?? c.detailsUrl };
    } else if (c.__typename === "StatusContext") {
      job = { name: c.context, state: jobState(c.state === "PENDING" || c.state === "EXPECTED" ? "PENDING" : "COMPLETED", c.state), url: c.targetUrl };
      run = { key: `ctx:${c.context}`, name: c.context, url: c.targetUrl };
    } else continue;
    const g = groups.get(run.key) ?? { ...run, jobs: [] };
    g.jobs.push(job); groups.set(run.key, g);
  }
  const runs = [...groups.values()].map((g) => {
    const n = (s) => g.jobs.filter((j) => j.state === s).length;
    const state = n("running") ? "running" : n("failed") ? "failed" : n("passed") ? "passed" : "neutral";
    return { ...g, state, done: g.jobs.length - n("running"), total: g.jobs.length };
  });
  const rank = { running: 0, failed: 1, neutral: 2, passed: 3 };
  runs.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
  return { state: rollup.state, runs, done: runs.reduce((s, r) => s + r.done, 0), total: runs.reduce((s, r) => s + r.total, 0) };
}

/** Turns the GraphQL `data` into what the view draws. */
export function parse(data) {
  const prs = (data.prs?.nodes ?? []).filter((p) => p && p.number).map((p) => ({
    repo: p.repository.nameWithOwner, number: p.number, title: p.title, url: p.url, draft: p.isDraft,
    review: p.reviewDecision, conflict: p.mergeable === "CONFLICTING", updatedAt: p.updatedAt,
    ...parseRollup(p.commits?.nodes?.[0]?.commit?.statusCheckRollup),
  }));
  const branches = Object.keys(data).filter((k) => /^r\d+$/.test(k)).map((k) => data[k]).filter((r) => r?.defaultBranchRef)
    .map((r) => { const t = r.defaultBranchRef.target ?? {};
      return { repo: r.nameWithOwner, branch: r.defaultBranchRef.name, headline: t.messageHeadline ?? "", oid: (t.oid ?? "").slice(0, 7), ...parseRollup(t.statusCheckRollup) }; });
  return { prs, branches, rate: data.rateLimit ?? null };
}

/** True when gh's error looks like a rate limit (primary or secondary). */
export const isRateLimit = (text) => /rate limit|secondary|abuse|HTTP 403|HTTP 429/i.test(text ?? "");
