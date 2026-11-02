import type { ToolServer } from "./gateway";
import type { Office } from "./office";

/** A pretend GitHub, so the stack can be tried without any real account. */
export const demoGithub: ToolServer = {
  tools: () => [
    { name: "list_pull_requests", description: "List open pull requests.", risk: "read", resourceArg: "repo" },
    { name: "comment_on_pull_request", description: "Comment on a pull request.", risk: "write", resourceArg: "repo" },
    { name: "delete_branch", description: "Delete a branch.", risk: "destructive", resourceArg: "repo" },
  ],
  async call(tool, args) {
    if (tool === "list_pull_requests") return [{ number: 212, title: "Settings: dark mode toggle", repo: args.repo }];
    return { ok: true };
  },
};

/** Adds a demo project, two agents and one pending approval. Safe to run more than once. */
export async function seedDemo(office: Office): Promise<void> {
  if (!office.projects.has("demo")) {
    office.addProject("demo", "Demo project");
    office.addAgent({ id: "ada", name: "Ada", role: "Developer", projectId: "demo", mode: "risky", model: "mid", status: "working", tokensToday: 18_400 });
    office.addAgent({ id: "quinn", name: "Quinn", role: "QA Reviewer", projectId: "demo", mode: "risky", model: "small", tokensToday: 6_400 });
    office.addGrant({ id: "g-ada", projectId: "demo", agentId: "ada", connectionId: "github", tools: ["list_pull_requests", "comment_on_pull_request", "delete_branch"], resources: ["demo-app"] });
    office.addGrant({ id: "g-quinn", projectId: "demo", agentId: "quinn", connectionId: "github", tools: ["list_pull_requests", "comment_on_pull_request"], resources: ["demo-app"] });
  }
  if (!office.vault.has("demo", "github")) office.vault.put("demo", "github", "ghp_demo0000000000000000000000000000000000");
  office.gateway.addConnection({ id: "github", projectId: "demo", service: "GitHub", label: "demo-org", credentialHandle: "github", server: demoGithub });
  await office.gateway.call("ada", "github", "delete_branch", { repo: "demo-app", branch: "old-experiment" });
}
