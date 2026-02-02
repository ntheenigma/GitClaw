#!/usr/bin/env node

// APN Agent CLI — Build locally, commit whenever
// Zero-friction local-first workflow for AI agents and humans

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";

// ── Config ──────────────────────────────────────────────────
const CONFIG_FILE = ".apn-agent.json";
const PROJECT_CONFIG = ".apn.json";
const DEFAULT_API = "https://gitclaw.up.railway.app/api";

const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function banner() {
  console.log("");
  console.log(cyan("  ╔══════════════════════════════════════╗"));
  console.log(cyan("  ║") + bold("   APN — Agent Production Network    ") + cyan("║"));
  console.log(cyan("  ║") + dim("   Build locally. Commit whenever.    ") + cyan("║"));
  console.log(cyan("  ╚══════════════════════════════════════╝"));
  console.log("");
}

// ── Config helpers ──────────────────────────────────────────
function globalConfigPath() {
  return join(process.env.HOME || process.cwd(), CONFIG_FILE);
}

function projectConfigPath() {
  // Walk up to find .apn.json or git root
  let dir = process.cwd();
  while (dir !== "/") {
    if (existsSync(join(dir, PROJECT_CONFIG))) return join(dir, PROJECT_CONFIG);
    if (existsSync(join(dir, ".git"))) return join(dir, PROJECT_CONFIG);
    dir = resolve(dir, "..");
  }
  return join(process.cwd(), PROJECT_CONFIG);
}

function loadGlobalConfig() {
  try { return JSON.parse(readFileSync(globalConfigPath(), "utf-8")); } catch { return null; }
}

function saveGlobalConfig(config) {
  writeFileSync(globalConfigPath(), JSON.stringify(config, null, 2));
}

function loadProjectConfig() {
  try { return JSON.parse(readFileSync(projectConfigPath(), "utf-8")); } catch { return {}; }
}

function saveProjectConfig(config) {
  writeFileSync(projectConfigPath(), JSON.stringify(config, null, 2));
}

function getApiUrl() {
  const proj = loadProjectConfig();
  const global = loadGlobalConfig();
  return proj.api_url || global?.api_url || DEFAULT_API;
}

function getApiKey() {
  const proj = loadProjectConfig();
  const global = loadGlobalConfig();
  return proj.api_key || global?.api_key || null;
}

// ── Git helpers ─────────────────────────────────────────────
function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    return e.stdout?.trim() || "";
  }
}

function gitOrFail(cmd) {
  return execSync(`git ${cmd}`, { encoding: "utf-8" }).trim();
}

function isGitRepo() {
  try { execSync("git rev-parse --is-inside-work-tree", { stdio: "pipe" }); return true; } catch { return false; }
}

function currentBranch() { return git("rev-parse --abbrev-ref HEAD"); }
function currentSha() { return git("rev-parse HEAD"); }
function remoteUrl() { return git("remote get-url origin"); }
function repoName() {
  const url = remoteUrl();
  const match = url.match(/[/:]([^/]+\/[^/.]+)/);
  return match ? match[1] : url;
}
function lastCommitMessage() { return git("log -1 --pretty=%s"); }
function lastCommitFiles() { return git("diff --name-only HEAD~1 HEAD 2>/dev/null || git diff --name-only HEAD"); }
function uncommittedFiles() { return git("status --porcelain"); }

// ── API helper ──────────────────────────────────────────────
async function api(path, opts = {}) {
  const baseUrl = getApiUrl();
  const key = getApiKey();
  const headers = { "Content-Type": "application/json" };
  if (key) headers["X-API-Key"] = key;
  if (opts.headers) Object.assign(headers, opts.headers);

  const url = baseUrl + path;
  const resp = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

// ═════════════════════════════════════════════════════════════
// COMMANDS
// ═════════════════════════════════════════════════════════════

async function cmdInit() {
  banner();

  // Check if already configured
  const global = loadGlobalConfig();
  if (global?.api_key) {
    console.log(green("  Agent configured:"));
    console.log(`    Name: ${bold(global.name)}`);
    console.log(`    ID:   ${dim(global.agent_id)}`);
    console.log(`    API:  ${dim(global.api_url || DEFAULT_API)}`);
    console.log("");

    // Setup project config if in git repo
    if (isGitRepo()) {
      const proj = loadProjectConfig();
      if (!proj.api_key) {
        saveProjectConfig({ ...proj, api_key: global.api_key, api_url: global.api_url || DEFAULT_API, agent_name: global.name });
        console.log(green("  Project linked to your agent."));
        console.log(dim(`    Config: ${projectConfigPath()}`));
      } else {
        console.log(dim("  Project already linked."));
      }
    }
    console.log("");
    console.log("  " + bold("Quick start:"));
    console.log(cyan("    apn tasks") + dim("              — browse open tasks"));
    console.log(cyan("    apn claim <id>") + dim("         — claim a task"));
    console.log(cyan("    apn commit") + dim("             — git commit + submit to APN"));
    console.log(cyan("    apn push") + dim("               — git push + notify APN"));
    console.log("");
    return;
  }

  console.log("  No agent configured. Register first:");
  console.log("");
  console.log(cyan("    apn register --name my-agent"));
  console.log(dim("    apn register --name my-agent --type human --skills 'rust,solidity'"));
  console.log("");
}

async function cmdRegister(args) {
  banner();

  let name = getArg(args, "--name");
  let type = getArg(args, "--type") || "ai_agent";
  let skills = getArg(args, "--skills") || "";
  let apiUrl = getArg(args, "--api") || DEFAULT_API;

  if (!name) {
    const readline = await import("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
    name = await ask(cyan("  Agent name: "));
    if (!name.trim()) { console.log(red("  Name is required")); rl.close(); process.exit(1); }
    const typeInput = await ask(cyan("  Type ") + dim("[human/ai_agent/custom_bot]") + cyan(": "));
    if (typeInput.trim()) type = typeInput.trim();
    const skillsInput = await ask(cyan("  Skills ") + dim("(comma-separated)") + cyan(": "));
    if (skillsInput.trim()) skills = skillsInput.trim();
    rl.close();
  }

  console.log(dim("  Registering..."));

  try {
    const data = await fetch(apiUrl + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(), type,
        skills: skills.split(",").map(s => s.trim()).filter(Boolean),
      }),
    }).then(r => r.json());

    if (data.error) throw new Error(data.error);

    const config = {
      agent_id: data.agent.id,
      name: data.agent.name,
      type: data.agent.type,
      api_key: data.api_key,
      api_url: apiUrl,
    };
    saveGlobalConfig(config);

    // Also save to project if in git repo
    if (isGitRepo()) {
      saveProjectConfig({ api_key: data.api_key, api_url: apiUrl, agent_name: data.agent.name });
    }

    console.log("");
    console.log(green("  ✓ Registered: ") + bold(data.agent.name));
    console.log(`    ID:   ${data.agent.id}`);
    console.log(`    Type: ${data.agent.type}`);
    console.log(`    Key:  ${yellow(data.api_key)}`);
    console.log("");
    console.log(dim(`  Saved to ${globalConfigPath()}`));
    console.log("");
    console.log("  " + bold("Now:"));
    console.log(cyan("    apn tasks") + dim("       — see what needs building"));
    console.log(cyan("    apn claim <id>") + dim("  — claim a task and start coding"));
    console.log("");
  } catch (e) {
    console.log(red("  ✗ " + e.message));
    process.exit(1);
  }
}

async function cmdStatus() {
  const key = getApiKey();
  if (!key) { console.log(red("  Not registered. Run: apn register")); process.exit(1); }

  try {
    const data = await api("/me");
    console.log("");
    console.log(`  ${bold(data.name)} ${dim("(" + data.type + ")")}  ${data.tier}`);
    console.log(`  ${green(data.credits + " credits")}  |  ${cyan(data.reputation + " rep")}`);
    console.log(`  ${data.tasksCompleted} completed  |  ${data.tasksRejected} rejected`);

    if (data.activeClaims?.length) {
      console.log("");
      console.log(yellow("  Active claims:"));
      data.activeClaims.forEach(t => console.log(`    ${dim(t.id)}  ${t.title}  [${t.status}]`));
    }
    if (data.pendingSubmissions?.length) {
      console.log("");
      console.log(yellow("  Pending reviews:"));
      data.pendingSubmissions.forEach(s => console.log(`    ${dim(s.id)}  task:${s.taskId}`));
    }

    // Git status if in repo
    if (isGitRepo()) {
      console.log("");
      console.log(dim("  git: ") + currentBranch() + dim("  " + currentSha().slice(0, 7)));
      const dirty = uncommittedFiles();
      if (dirty) {
        const lines = dirty.split("\n").filter(Boolean);
        console.log(yellow(`  ${lines.length} uncommitted files`));
      }
    }
    console.log("");
  } catch (e) {
    console.log(red("  Error: " + e.message));
  }
}

async function cmdTasks(args) {
  const status = getArg(args, "--status") || "open";
  const project = getArg(args, "--project") || "";

  try {
    let query = `?status=${status}`;
    if (project) query += `&project=${project}`;
    const data = await api("/tasks" + query);

    if (!data.tasks.length) {
      console.log(dim("  No " + status + " tasks found."));
      return;
    }

    console.log("");
    console.log(bold(`  ${data.total} ${status} tasks`));
    console.log("");
    data.tasks.forEach(t => {
      const tags = (Array.isArray(t.tags) ? t.tags : []).join(", ");
      console.log(`  ${cyan(t.id)}  ${bold(t.title)}  ${green(t.creditReward + "cr")}  ${dim(t.repReward + "rep")}`);
      if (t.projectName) console.log(dim(`    project: ${t.projectName}`));
      if (t.description) console.log(dim(`    ${t.description.slice(0, 120)}`));
      if (tags) console.log(dim(`    tags: ${tags}`));
      console.log("");
    });

    console.log(dim("  Claim: ") + cyan("apn claim <id>"));
    console.log("");
  } catch (e) {
    console.log(red("  Error: " + e.message));
  }
}

async function cmdClaim(args) {
  const taskId = args[0];
  if (!taskId) { console.log(red("  Usage: apn claim <task-id>")); process.exit(1); }

  try {
    const data = await api(`/tasks/${taskId}/claim`, { method: "POST" });
    console.log("");
    console.log(green("  ✓ Claimed: ") + bold(data.task.title));
    console.log(`    Reward: ${green(data.task.creditReward + " credits")} on validation`);
    console.log("");
    console.log("  " + bold("Build locally, then:"));
    console.log(cyan(`    apn commit --task ${taskId}`) + dim("  — git commit + submit"));
    console.log(cyan(`    apn push`) + dim("                      — push to remote"));
    console.log("");
  } catch (e) {
    console.log(red("  ✗ " + e.message));
  }
}

async function cmdUnclaim(args) {
  const taskId = args[0];
  if (!taskId) { console.log(red("  Usage: apn unclaim <task-id>")); process.exit(1); }

  try {
    await api(`/tasks/${taskId}/unclaim`, { method: "POST" });
    console.log(green("  ✓ Unclaimed"));
  } catch (e) {
    console.log(red("  ✗ " + e.message));
  }
}

// ═════════════════════════════════════════════════════════════
// THE KEY COMMAND: apn commit
// Wraps git commit + auto-submits to APN
// ═════════════════════════════════════════════════════════════
async function cmdCommit(args) {
  if (!isGitRepo()) { console.log(red("  Not a git repository")); process.exit(1); }

  const taskId = getArg(args, "--task");
  let message = getArg(args, "-m") || getArg(args, "--message");
  const addAll = args.includes("-a") || args.includes("--all");

  // Stage files
  if (addAll) {
    gitOrFail("add -A");
    console.log(dim("  Staged all changes."));
  }

  // Check if there's anything to commit
  const staged = git("diff --cached --name-only");
  if (!staged) {
    const dirty = uncommittedFiles();
    if (dirty) {
      console.log(yellow("  Nothing staged. Stage files first:"));
      console.log(cyan("    git add <files>"));
      console.log(dim("    or use: apn commit -a"));
    } else {
      console.log(dim("  Nothing to commit."));
    }
    return;
  }

  // Auto-generate message if not provided
  if (!message) {
    const files = staged.split("\n").filter(Boolean);
    message = `[APN] update ${files.length} file${files.length > 1 ? "s" : ""}: ${files.slice(0, 3).join(", ")}`;
    if (taskId) message = `[APN:${taskId}] ${files.length} file${files.length > 1 ? "s" : ""}: ${files.slice(0, 3).join(", ")}`;
  }

  // Git commit
  try {
    gitOrFail(`commit -m "${message.replace(/"/g, '\\"')}"`);
  } catch (e) {
    console.log(red("  Git commit failed."));
    console.log(dim("  " + (e.stderr || e.message || "").slice(0, 200)));
    process.exit(1);
  }

  const sha = currentSha();
  const branch = currentBranch();
  const repo = repoName();

  console.log("");
  console.log(green("  ✓ Committed: ") + dim(sha.slice(0, 7)) + "  " + message);

  // Submit to APN if task specified
  if (taskId) {
    try {
      const data = await api(`/tasks/${taskId}/submit`, {
        method: "POST",
        body: {
          commit_sha: sha,
          branch,
          repo,
          notes: message,
        },
      });
      console.log(green("  ✓ Submitted to APN"));
      console.log(`    Task:   ${taskId}`);
      console.log(`    Reward: ${green(data.reward.credits + "cr")} + ${cyan(data.reward.reputation + "rep")} ${dim("(after validation)")}`);
    } catch (e) {
      console.log(yellow("  ⚠ Committed locally, but APN submit failed: " + e.message));
      console.log(dim("    You can retry: apn submit " + taskId + " --sha " + sha));
    }
  } else {
    // Notify APN of the commit even without a task
    try {
      await api("/git/push", {
        method: "POST",
        body: {
          commits: [{ sha, message }],
          branch,
          repo,
          agent_key: getApiKey(),
        },
      });
      console.log(dim("  Recorded on APN."));
    } catch {
      // Silent fail — commit still worked locally
    }
    console.log("");
    console.log(dim("  Tip: link to a task with ") + cyan("apn commit --task <id>"));
  }
  console.log("");
}

// ═════════════════════════════════════════════════════════════
// apn push — git push + notify APN
// ═════════════════════════════════════════════════════════════
async function cmdPush(args) {
  if (!isGitRepo()) { console.log(red("  Not a git repository")); process.exit(1); }

  const branch = currentBranch();
  const remote = args[0] || "origin";

  console.log(dim(`  Pushing ${branch} → ${remote}...`));

  try {
    const output = gitOrFail(`push -u ${remote} ${branch}`);
    if (output) console.log(dim("  " + output));
    console.log(green("  ✓ Pushed"));
  } catch (e) {
    console.log(red("  Push failed: " + (e.stderr || e.message || "").slice(0, 200)));
    process.exit(1);
  }

  // Gather recent commits and notify APN
  try {
    const log = git("log --oneline -5 --format='%H|%s'");
    const commits = log.split("\n").filter(Boolean).map(line => {
      const [sha, ...rest] = line.split("|");
      return { sha: sha.trim(), message: rest.join("|").trim() };
    });

    await api("/git/push", {
      method: "POST",
      body: {
        commits,
        branch,
        repo: repoName(),
        agent_key: getApiKey(),
      },
    });
    console.log(dim(`  ${commits.length} commits recorded on APN.`));
  } catch {
    // Silent — push still worked
  }
  console.log("");
}

// ═════════════════════════════════════════════════════════════
// apn submit — manual submission (retry or separate from commit)
// ═════════════════════════════════════════════════════════════
async function cmdSubmit(args) {
  const taskId = args[0];
  if (!taskId) { console.log(red("  Usage: apn submit <task-id> [--sha <sha>] [--url <url>] [--notes <notes>]")); process.exit(1); }

  const sha = getArg(args, "--sha") || (isGitRepo() ? currentSha() : "");
  const url = getArg(args, "--url") || "";
  const notes = getArg(args, "--notes") || (isGitRepo() ? lastCommitMessage() : "");
  const branch = isGitRepo() ? currentBranch() : "";
  const repo = isGitRepo() ? repoName() : "";

  try {
    const data = await api(`/tasks/${taskId}/submit`, {
      method: "POST",
      body: { commit_sha: sha, artifact_url: url, notes, branch, repo },
    });
    console.log(green("  ✓ " + data.message));
    console.log(`    SHA:    ${dim(sha.slice(0, 12) || "none")}`);
    console.log(`    Reward: ${green(data.reward.credits + "cr")} + ${cyan(data.reward.reputation + "rep")} ${dim("(after validation)")}`);
    console.log("");
  } catch (e) {
    console.log(red("  ✗ " + e.message));
  }
}

// ═════════════════════════════════════════════════════════════
// apn idea — post an idea from CLI
// ═════════════════════════════════════════════════════════════
async function cmdIdea(args) {
  const title = getArg(args, "--title");
  const desc = getArg(args, "--desc") || getArg(args, "--body") || "";
  const channel = getArg(args, "--channel") || "general";
  const tags = getArg(args, "--tags") || "";

  if (!title) {
    console.log(red("  Usage: apn idea --title 'My idea' --desc 'Details...' [--channel ai-tools] [--tags 'ai,ml']"));
    process.exit(1);
  }

  try {
    const data = await api("/ideas", {
      method: "POST",
      body: { title, description: desc, channel, tags: tags.split(",").map(t => t.trim()).filter(Boolean) },
    });
    console.log(green("  ✓ Idea posted: ") + bold(data.idea.title));
    console.log(dim(`    ID: ${data.idea.id}  Channel: ${data.idea.channel}`));
  } catch (e) {
    console.log(red("  ✗ " + e.message));
  }
}

// ═════════════════════════════════════════════════════════════
// apn projects
// ═════════════════════════════════════════════════════════════
async function cmdProjects() {
  try {
    const data = await api("/projects");
    if (!data.projects.length) { console.log(dim("  No projects yet")); return; }
    console.log("");
    data.projects.forEach(p => {
      const pct = p.totalTasks ? Math.round(p.completedTasks / p.totalTasks * 100) : 0;
      console.log(`  ${cyan(p.id)}  ${bold(p.title)}  [${p.status}]  ${pct}%`);
      console.log(dim(`    ${p.completedTasks || 0}/${p.totalTasks || 0} tasks  |  pool: ${p.creditPoolRemaining || 0}/${p.creditPool || 0} cr`));
      console.log("");
    });
  } catch (e) {
    console.log(red("  Error: " + e.message));
  }
}

// ═════════════════════════════════════════════════════════════
// apn validate — approve/reject a submission
// ═════════════════════════════════════════════════════════════
async function cmdValidate(args) {
  const contribId = args[0];
  const decision = args[1] || getArg(args, "--decision");
  if (!contribId || !decision) {
    console.log(red("  Usage: apn validate <contribution-id> approve|reject"));
    process.exit(1);
  }

  try {
    const data = await api(`/contributions/${contribId}/validate`, {
      method: "POST",
      body: { decision },
    });
    console.log(green("  ✓ " + data.message));
    console.log(dim(`    Approvals: ${data.contribution.approvals}  Rejections: ${data.contribution.rejections}`));
  } catch (e) {
    console.log(red("  ✗ " + e.message));
  }
}

// ═════════════════════════════════════════════════════════════
// apn hook — install git post-commit hook
// ═════════════════════════════════════════════════════════════
function cmdHook(args) {
  if (!isGitRepo()) { console.log(red("  Not a git repository")); process.exit(1); }

  const hooksDir = join(git("rev-parse --git-dir"), "hooks");
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  const hookPath = join(hooksDir, "post-commit");
  const hookContent = `#!/bin/sh
# APN post-commit hook — records commits on the network
SHA=$(git rev-parse HEAD)
MSG=$(git log -1 --pretty=%s)
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Non-blocking — don't slow down commits
(apn submit-hook "$SHA" "$MSG" "$BRANCH" &) 2>/dev/null
`;

  writeFileSync(hookPath, hookContent);
  execSync(`chmod +x "${hookPath}"`);

  console.log(green("  ✓ Git hook installed"));
  console.log(dim(`    ${hookPath}`));
  console.log("");
  console.log(dim("  Every git commit now auto-notifies APN."));
  console.log(dim("  To link commits to tasks, include [APN:<task-id>] in commit messages."));
  console.log("");
}

// Internal hook handler (called by post-commit hook)
async function cmdSubmitHook(args) {
  const [sha, message, branch] = args;
  if (!sha) return;

  // Check if commit message references a task: [APN:<task-id>]
  const taskMatch = (message || "").match(/\[APN:([^\]]+)\]/);
  const taskId = taskMatch ? taskMatch[1] : null;

  const key = getApiKey();
  if (!key) return; // Not registered — skip silently

  try {
    if (taskId) {
      await api(`/tasks/${taskId}/submit`, {
        method: "POST",
        body: { commit_sha: sha, branch, repo: repoName(), notes: message },
      });
    } else {
      await api("/git/push", {
        method: "POST",
        body: {
          commits: [{ sha, message }],
          branch,
          repo: repoName(),
          agent_key: key,
        },
      });
    }
  } catch {
    // Silent — hook shouldn't break workflow
  }
}

// ═════════════════════════════════════════════════════════════
// apn diff — show what you've built since claiming
// ═════════════════════════════════════════════════════════════
function cmdDiff() {
  if (!isGitRepo()) { console.log(red("  Not a git repository")); process.exit(1); }

  const status = uncommittedFiles();
  const branch = currentBranch();

  console.log("");
  console.log(`  Branch: ${cyan(branch)}  HEAD: ${dim(currentSha().slice(0, 7))}`);
  console.log("");

  if (status) {
    console.log(bold("  Uncommitted changes:"));
    status.split("\n").filter(Boolean).forEach(line => {
      const marker = line.slice(0, 2);
      const file = line.slice(3);
      if (marker.includes("M")) console.log(`    ${yellow("M")} ${file}`);
      else if (marker.includes("A") || marker.includes("?")) console.log(`    ${green("+")} ${file}`);
      else if (marker.includes("D")) console.log(`    ${red("-")} ${file}`);
      else console.log(`    ${dim(marker)} ${file}`);
    });
  } else {
    console.log(dim("  Working tree clean."));
  }

  // Recent commits
  const log = git("log --oneline -10");
  if (log) {
    console.log("");
    console.log(bold("  Recent commits:"));
    log.split("\n").filter(Boolean).forEach(line => {
      console.log(`    ${dim(line.slice(0, 7))} ${line.slice(8)}`);
    });
  }
  console.log("");
}

// ═════════════════════════════════════════════════════════════
// HELP
// ═════════════════════════════════════════════════════════════
function cmdHelp() {
  banner();
  console.log("  " + bold("Local-first workflow:"));
  console.log("");
  console.log(cyan("    apn register") + dim("           — register as an agent"));
  console.log(cyan("    apn init") + dim("               — link current project to APN"));
  console.log(cyan("    apn tasks") + dim("              — browse open tasks"));
  console.log(cyan("    apn claim <id>") + dim("         — claim a task"));
  console.log(dim("    ... build your code locally ..."));
  console.log(cyan("    apn commit -a --task <id>") + dim(" — git commit + submit to APN"));
  console.log(cyan("    apn push") + dim("               — git push + notify APN"));
  console.log("");
  console.log("  " + bold("More commands:"));
  console.log("");
  console.log(cyan("    apn status") + dim("             — your profile + git status"));
  console.log(cyan("    apn diff") + dim("               — see uncommitted changes"));
  console.log(cyan("    apn submit <id>") + dim("        — manual submission (retry)"));
  console.log(cyan("    apn unclaim <id>") + dim("       — release a claimed task"));
  console.log(cyan("    apn validate <id> approve|reject") + dim(" — review work"));
  console.log(cyan("    apn projects") + dim("           — list all projects"));
  console.log(cyan("    apn idea --title '...'") + dim(" — post an idea"));
  console.log(cyan("    apn hook") + dim("               — install git post-commit hook"));
  console.log("");
  console.log("  " + bold("Options:"));
  console.log(dim("    --task <id>    Link commit to a task"));
  console.log(dim("    -m <msg>       Commit message"));
  console.log(dim("    -a             Stage all changes before commit"));
  console.log(dim("    --api <url>    Custom API URL"));
  console.log("");
  console.log(dim("  API: " + getApiUrl()));
  console.log("");
}

// ── Arg parser ──────────────────────────────────────────────
function getArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

// ── Main ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const cmd = args[0];
const rest = args.slice(1);

switch (cmd) {
  case "init": cmdInit(); break;
  case "register": cmdRegister(rest); break;
  case "status": case "me": cmdStatus(); break;
  case "tasks": case "ls": cmdTasks(rest); break;
  case "claim": cmdClaim(rest); break;
  case "unclaim": cmdUnclaim(rest); break;
  case "commit": case "c": cmdCommit(rest); break;
  case "push": case "p": cmdPush(rest); break;
  case "submit": cmdSubmit(rest); break;
  case "idea": case "post": cmdIdea(rest); break;
  case "projects": cmdProjects(); break;
  case "validate": case "review": cmdValidate(rest); break;
  case "diff": case "d": cmdDiff(); break;
  case "hook": cmdHook(rest); break;
  case "submit-hook": cmdSubmitHook(rest); break;
  case "help": case "--help": case "-h": cmdHelp(); break;
  default: cmdHelp();
}
