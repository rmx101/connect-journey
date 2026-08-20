#!/usr/bin/env node
// Regenerates data/stats.json from the rmx101/Connect repository.
// Uses an explicit token when provided, otherwise the local gh CLI token:
//   CONNECT_READ_TOKEN=... node scripts/refresh-stats.mjs
// Authenticate with `gh auth login` if no token is available.

import { execFileSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OWNER = 'rmx101';
const NAME = 'Connect';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'stats.json');

function localGhToken() {
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const TOKEN =
  process.env.CONNECT_READ_TOKEN ||
  process.env.GITHUB_TOKEN ||
  localGhToken();

if (!TOKEN) {
  console.error(
    'A GitHub token is required. Set CONNECT_READ_TOKEN or GITHUB_TOKEN, or authenticate with `gh auth login`.'
  );
  process.exit(1);
}

async function graphql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'connect-journey-stats',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.errors) throw new Error(`GitHub GraphQL: ${JSON.stringify(body.errors)}`);
  return body.data;
}

const COMMITS_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { committedDate }
          }
        }
      }
    }
  }
}`;

const PRS_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: 100, orderBy: {field: CREATED_AT, direction: DESC}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { number title mergedAt additions deletions changedFiles }
    }
  }
}`;

const monthKey = (iso) => iso.slice(0, 7);

async function fetchCommits() {
  const dates = [];
  let cursor = null;
  for (;;) {
    const data = await graphql(COMMITS_QUERY, { owner: OWNER, name: NAME, cursor });
    const history = data.repository.defaultBranchRef.target.history;
    for (const node of history.nodes) dates.push(node.committedDate);
    if (!history.pageInfo.hasNextPage) break;
    cursor = history.pageInfo.endCursor;
  }
  return dates;
}

async function fetchMergedPRs() {
  const prs = [];
  let cursor = null;
  for (;;) {
    const data = await graphql(PRS_QUERY, { owner: OWNER, name: NAME, cursor });
    const page = data.repository.pullRequests;
    for (const node of page.nodes) if (node.mergedAt) prs.push(node);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return prs;
}

const [commitDates, prs] = await Promise.all([fetchCommits(), fetchMergedPRs()]);

const months = new Map();
const month = (key) => {
  if (!months.has(key)) months.set(key, { month: key, commits: 0, mergedPrs: 0, additions: 0, deletions: 0 });
  return months.get(key);
};

for (const date of commitDates) month(monthKey(date)).commits += 1;
for (const pr of prs) {
  const m = month(monthKey(pr.mergedAt));
  m.mergedPrs += 1;
  m.additions += pr.additions;
  m.deletions += pr.deletions;
}

const byMonth = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
const recent = [...prs]
  .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
  .slice(0, 25)
  .map(({ number, title, mergedAt, additions, deletions, changedFiles }) => ({
    number,
    title,
    mergedAt,
    additions,
    deletions,
    changedFiles,
  }));

const first = commitDates.length ? commitDates.reduce((a, b) => (a < b ? a : b)) : null;
const last = commitDates.length ? commitDates.reduce((a, b) => (a > b ? a : b)) : null;
const monthsSpanned = byMonth.length;

const stats = {
  generatedAt: new Date().toISOString(),
  repo: `${OWNER}/${NAME}`,
  totals: {
    commits: commitDates.length,
    mergedPrs: prs.length,
    additions: prs.reduce((sum, pr) => sum + pr.additions, 0),
    deletions: prs.reduce((sum, pr) => sum + pr.deletions, 0),
    monthsActive: monthsSpanned,
    firstCommit: first,
    lastCommit: last,
  },
  byMonth,
  recentMergedPrs: recent,
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(stats, null, 2)}\n`);
console.log(
  `wrote ${OUT}: ${stats.totals.commits} commits, ${stats.totals.mergedPrs} merged PRs, ` +
    `+${stats.totals.additions}/-${stats.totals.deletions} across ${monthsSpanned} months`
);
