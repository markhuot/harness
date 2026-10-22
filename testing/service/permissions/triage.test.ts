import { expect, test } from "bun:test";
import { isReadOnlyCommand, isTriageCommand } from "../../../service/src/permissions/bash";
import { mcpToolName, triageDecision } from "../../../service/src/permissions/triage";

const bash = (command: string) => triageDecision("Bash", { command }).behavior;

test("gh reads are read-only commands", () => {
  for (const c of [
    "gh pr view 1297 --repo ACAMSLLC/CMS-Drupal --json reviews,comments",
    "gh pr diff 1297",
    "gh pr checks 1297",
    "gh pr list --state open",
    "gh issue view 12 --comments",
    "gh run view 99 --log-failed",
    "gh api repos/ACAMSLLC/CMS-Drupal/pulls/1297/comments",
    "gh api /repos/x/y/pulls/1/reviews --paginate --jq '.[].user.login'",
    "gh search prs --owner acme copilot",
    "gh pr view 1 | jq .title",
  ]) expect(isReadOnlyCommand(c)).toBe(true);
});

test("gh calls that write, post or leave the repo are not", () => {
  for (const c of [
    "gh pr merge 1297",
    "gh pr comment 1 --body hi",
    "gh pr edit 1 --title x",
    "gh pr checkout 1",
    "gh pr view 1 && gh pr merge 1",
    "gh pr view 1; gh issue close 2",
    "gh pr view 1 --web",
    "gh pr checks 1 --watch",
    "gh api repos/x/y/issues -f title=x",
    "gh api repos/x/y/issues -F title=x",
    "gh api repos/x/y/issues --field title=x",
    "gh api repos/x/y/issues --raw-field title=x",
    "gh api repos/x/y/issues --input body.json",
    "gh api -X DELETE repos/x/y/issues/1",
    "gh api --method=POST repos/x/y/issues",
    "gh api repos/x/y -H 'X-HTTP-Method-Override: DELETE'",
    "gh api graphql -f query='{ viewer { login } }'",
    "gh api /graphql",
    "gh api repos/x/y --hostname evil.example",
    "gh api",
    "gh auth login",
    "gh auth token",
    "gh alias set x 'pr merge'",
    "gh extension install evil/ext",
    "gh gist create secrets.txt",
    "gh secret set X",
    "gh -R x/y pr view 1",
    "gh",
    "gh pr view $(gh auth token)",
    "gh pr view 1 > /tmp/out",
  ]) expect(isReadOnlyCommand(c)).toBe(false);
});

test("triage Bash can't read outside its empty folder", () => {
  expect(isTriageCommand("gh api /repos/x/y/pulls/1")).toBe(true);
  expect(isTriageCommand("gh pr view 1 | jq '.title' | head -3")).toBe(true);
  for (const c of ["cat ~/.harness/token", "cat /etc/passwd", "ls ..", "cat ../secret", "grep -r key /Users", "head -n1 --file=/etc/hosts"]) expect(isTriageCommand(c)).toBe(false);
  expect(isTriageCommand("rm -rf x")).toBe(false);
});

test("triage answers Bash by the read-only policy, MCP tools by their names, and everything else no", () => {
  expect(bash("gh pr view 1")).toBe("allow");
  expect(bash("gh pr merge 1")).toBe("deny");
  expect(bash("curl -X POST https://example.com")).toBe("deny");
  expect(triageDecision("Bash", {}).behavior).toBe("deny");
  expect(triageDecision("Bash", { command: 5 }).behavior).toBe("deny");

  for (const t of ["get-issue", "list-comments", "search-issues", "find-users", "getJiraIssue", "listProjects", "read_page", "query-database", "get_issue", "search"]) {
    expect(triageDecision(`mcp__claude_ai_hc-jira__${t}`, {}).behavior).toBe("allow");
  }
  for (const t of ["add-comment", "create-issue", "transition-issue", "update-issue", "delete-comment", "manage-watchers", "getaway", "budget-list", "send_message"]) {
    expect(triageDecision(`mcp__claude_ai_hc-jira__${t}`, {}).behavior).toBe("deny");
  }
  for (const t of ["Edit", "Write", "Read", "WebFetch", "Agent", "Task", "NotebookEdit"]) expect(triageDecision(t, {}).behavior).toBe("deny");
});

test("the tool name is what follows the server's prefix, whatever the server is called", () => {
  expect(mcpToolName("mcp__claude_ai_hc-jira__get-issue")).toBe("get-issue");
  expect(mcpToolName("mcp__jira__get_issue")).toBe("get_issue");
  expect(mcpToolName("Bash")).toBeNull();
});
