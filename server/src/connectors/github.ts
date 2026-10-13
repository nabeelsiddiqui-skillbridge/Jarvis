import { Connector, Credentials, getJson, relTime } from "./types.js";

const api = (path: string, creds: Credentials) =>
  getJson(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${creds.token}`, "X-GitHub-Api-Version": "2022-11-28" },
  });

async function login(creds: Credentials): Promise<string> {
  return (await api("/user", creds)).login;
}

export const github: Connector = {
  id: "github",
  name: "GitHub",
  category: "Developer",
  description: "Pull requests, notifications, repo stars and activity.",
  auth: "token",
  docsUrl: "https://github.com/settings/tokens?type=beta",
  fields: [
    {
      key: "token",
      label: "Personal access token",
      placeholder: "github_pat_…",
      secret: true,
      help: "Fine-grained token with read access to repositories and notifications.",
    },
  ],
  metrics: [
    { id: "open_prs", label: "My open pull requests", viz: ["stat", "list"] },
    { id: "notifications", label: "Unread notifications", viz: ["list", "stat"] },
    { id: "repo_stars", label: "Stars per repository", viz: ["bar", "list"] },
    { id: "activity", label: "Recent activity", viz: ["list"] },
  ],
  async verify(creds) {
    await login(creds);
  },
  async updates(creds) {
    const me = await login(creds);
    const [notes, prs] = await Promise.all([
      api("/notifications?per_page=10", creds),
      api(`/search/issues?q=${encodeURIComponent(`is:open is:pr author:${me}`)}&per_page=10`, creds),
    ]);
    const lines = [`Signed in as ${me}.`, `${prs.total_count} open pull request(s) authored.`];
    for (const pr of prs.items.slice(0, 5)) lines.push(`- PR: ${pr.title} (${pr.repository_url.split("/").slice(-1)[0]}), updated ${relTime(pr.updated_at)}`);
    lines.push(`${notes.length} unread notification(s).`);
    for (const n of notes.slice(0, 8)) lines.push(`- ${n.subject.type}: ${n.subject.title} in ${n.repository.full_name} (${n.reason})`);
    return lines.join("\n");
  },
  async fetchMetric(metric, creds) {
    switch (metric) {
      case "open_prs": {
        const me = await login(creds);
        const prs = await api(`/search/issues?q=${encodeURIComponent(`is:open is:pr author:${me}`)}&per_page=15`, creds);
        return {
          kind: "list",
          items: prs.items.map((pr: any) => ({
            title: pr.title,
            subtitle: pr.repository_url.split("/").slice(-2).join("/"),
            url: pr.html_url,
            time: relTime(pr.updated_at),
          })),
        };
      }
      case "notifications": {
        const notes = await api("/notifications?per_page=20", creds);
        return {
          kind: "list",
          items: notes.map((n: any) => ({
            title: n.subject.title,
            subtitle: `${n.repository.full_name} · ${n.reason}`,
            time: relTime(n.updated_at),
          })),
        };
      }
      case "repo_stars": {
        const repos = await api("/user/repos?per_page=100&sort=updated&affiliation=owner", creds);
        return {
          kind: "series",
          points: repos
            .sort((a: any, b: any) => b.stargazers_count - a.stargazers_count)
            .slice(0, 8)
            .map((r: any) => ({ label: r.name, value: r.stargazers_count })),
        };
      }
      case "activity": {
        const me = await login(creds);
        const events = await api(`/users/${me}/events?per_page=20`, creds);
        return {
          kind: "list",
          items: events.map((e: any) => ({
            title: e.type.replace(/Event$/, ""),
            subtitle: e.repo.name,
            time: relTime(e.created_at),
          })),
        };
      }
    }
    throw new Error(`Unknown GitHub metric ${metric}`);
  },
};
