import type { ApprovalMode } from "./domain";

/*
 * Role templates for hiring. A template only fills in the form: a new teammate always starts with
 * no tool access, whatever the template says, and you can change every field before hiring.
 */

export interface RoleTemplate {
  id: string;
  role: string;
  /** One line for the card. */
  blurb: string;
  /** A few words the Manager reads when it picks someone. */
  skills: string;
  mode: ApprovalMode;
  /** Model alias for Claude Code. */
  engineModel: string;
}

export const ROLE_TEMPLATES: RoleTemplate[] = [
  { id: "developer", role: "Developer", blurb: "Reads code and pull requests, writes fixes and features.", skills: "typescript, code review, github, debugging", mode: "risky", engineModel: "sonnet" },
  { id: "qa", role: "QA Reviewer", blurb: "Checks work against the acceptance criteria before you see it.", skills: "code review, testing, acceptance criteria", mode: "risky", engineModel: "sonnet" },
  { id: "devops", role: "DevOps", blurb: "Deployments, logs, infrastructure and incidents.", skills: "deploys, logs, ci, infrastructure", mode: "every", engineModel: "sonnet" },
  { id: "support", role: "Support", blurb: "Answers customer questions and drafts replies.", skills: "customer replies, triage, documentation", mode: "every", engineModel: "haiku" },
  { id: "marketing", role: "Marketer", blurb: "Drafts posts, campaigns and copy.", skills: "copywriting, social posts, campaigns", mode: "every", engineModel: "sonnet" },
  { id: "sales", role: "Sales", blurb: "Researches leads and drafts outreach.", skills: "lead research, outreach drafts, follow-ups", mode: "every", engineModel: "sonnet" },
  { id: "researcher", role: "Researcher", blurb: "Looks things up and writes short briefs with sources.", skills: "research, summaries, comparisons", mode: "risky", engineModel: "haiku" },
];
