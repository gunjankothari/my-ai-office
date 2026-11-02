// A GitHub-shaped MCP server for tests: same tool names and argument shapes as the real one
// (owner and repo as separate required arguments), no network. Never talks to GitHub.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
const expect = process.env.FIXTURE_EXPECT_TOKEN;
const bad = () => (expect && token !== expect ? { isError: true, content: [{ type: "text", text: "401 Bad credentials" }] } : null);
const text = (t) => bad() ?? { content: [{ type: "text", text: t }] };
const ro = { readOnlyHint: true };
const server = new McpServer({ name: "github-mcp-server", version: "0.0.0-fixture" });

server.registerTool("get_me", { description: "Get my user profile", inputSchema: {}, annotations: ro }, async () => text(JSON.stringify({ login: "test-user" })));
server.registerTool("list_pull_requests", { description: "List pull requests in a GitHub repository.", inputSchema: { owner: z.string(), repo: z.string(), state: z.string().optional() }, annotations: ro },
  async ({ owner, repo }) => text(JSON.stringify([{ number: 212, title: "Settings: dark mode toggle", repo: `${owner}/${repo}` }])));
server.registerTool("get_file_contents", { description: "Get the contents of a file or directory.", inputSchema: { owner: z.string(), repo: z.string(), path: z.string() }, annotations: ro },
  async ({ path }) => text(`contents of ${path}`));
server.registerTool("pull_request_read", { description: "Get information on a specific pull request.", inputSchema: { method: z.string(), owner: z.string(), repo: z.string(), pullNumber: z.number() }, annotations: ro },
  async () => text("pull request details"));
server.registerTool("search_issues", { description: "Search issues. The query can name any repository.", inputSchema: { query: z.string(), owner: z.string().optional(), repo: z.string().optional() }, annotations: ro },
  async () => text("search results"));
server.registerTool("create_pull_request", { description: "Create a new pull request.", inputSchema: { owner: z.string(), repo: z.string(), title: z.string(), head: z.string(), base: z.string() } }, async () => text("created"));
server.registerTool("merge_pull_request", { description: "Merge a pull request.", inputSchema: { owner: z.string(), repo: z.string(), pullNumber: z.number() } }, async () => text("merged"));
server.registerTool("issue_write", { description: "Create or update an issue.", inputSchema: { owner: z.string(), repo: z.string(), method: z.string() } }, async () => text("written"));

await server.connect(new StdioServerTransport());
