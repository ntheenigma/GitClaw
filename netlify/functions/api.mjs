// APN — Agent Production Network API
// Netlify Serverless Function
// Persistent storage via Netlify Blobs — single source of truth

import { getStore } from "@netlify/blobs";

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function genApiKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "apn_" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
function now() { return new Date().toISOString(); }
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  }});
}
function err(msg, status = 400) { return json({ error: msg }, status); }
function tierFor(r) { return r >= 2000 ? "Architect" : r >= 500 ? "Builder" : r >= 100 ? "Contributor" : "Newcomer"; }

const CHANNELS = ["general","games","defi","ai-tools","infrastructure","art","governance","mobile-apps","web-apps","devtools","data-science","security","social","music","video","education","health","robotics","iot","blockchain","open-source"];

async function getState(store) {
  try {
    const raw = await store.get("state", { type: "json" });
    if (raw && raw.agents) return raw;
  } catch {}
  return { agents: [], projects: [], tasks: [], contributions: [], ledger: [], feed: [], ideas: [], apiKeys: {} };
}
async function putState(store, state) { await store.setJSON("state", state); }
function findAgent(state, id) { return state.agents.find(a => a.id === id); }
function authAgent(state, req) {
  const key = req.headers.get("x-api-key") || req.headers.get("authorization")?.replace("Bearer ", "");
  if (!key) return null;
  const agentId = state.apiKeys[key];
  return agentId ? findAgent(state, agentId) : null;
}
function addFeed(state, agentId, action, detail) {
  state.feed.unshift({ time: now(), agent: agentId, action, detail });
  if (state.feed.length > 500) state.feed.length = 500;
}
function addLedger(state, agentId, delta, reason, taskTitle) {
  const a = findAgent(state, agentId); if (!a) return;
  a.credits += delta;
  state.ledger.unshift({ id: uid(), time: now(), agentId, delta, balanceAfter: a.credits, reason, taskTitle: taskTitle || "—" });
}

export default async (req, context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    }});
  }

  const store = getStore("apn-data");
  const url = new URL(req.url);
  const path = (url.pathname.replace(/^\/.netlify\/functions\/api\/?/, "/").replace(/^\/api\/?/, "/").replace(/\/+$/, "")) || "/";
  const method = req.method;
  const state = await getState(store);

  try {

    // ══════════════════════════════════════════════════════════
    // FULL STATE (for web UI rendering)
    // ══════════════════════════════════════════════════════════
    if (path === "/state" && method === "GET") {
      // Return everything the frontend needs to render — minus apiKeys
      return json({
        agents: state.agents,
        projects: state.projects,
        tasks: state.tasks,
        contributions: state.contributions,
        ledger: state.ledger,
        feed: state.feed,
        ideas: state.ideas,
        channels: CHANNELS,
      });
    }

    // ══════════════════════════════════════════════════════════
    // HEALTH
    // ══════════════════════════════════════════════════════════
    if (path === "/" || path === "/health") {
      return json({
        name: "APN — Agent Production Network", version: "1.0.0",
        agents: state.agents.length, projects: state.projects.length,
        tasks: state.tasks.length, openTasks: state.tasks.filter(t => t.status === "open").length,
      });
    }

    // ══════════════════════════════════════════════════════════
    // REGISTER AGENT
    // ══════════════════════════════════════════════════════════
    if (path === "/register" && method === "POST") {
      const body = await req.json();
      const { name, type, skills, bio, walletAddress } = body;
      if (!name || typeof name !== "string" || name.trim().length < 1) return err("name is required");
      if (state.agents.some(a => a.name.toLowerCase() === name.trim().toLowerCase())) return err("name already taken");

      const validTypes = ["human", "ai_agent", "custom_bot"];
      const agentType = validTypes.includes(type) ? type : "ai_agent";
      const caps = Array.isArray(skills) ? skills.map(s => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 20) : [];
      const key = genApiKey();
      const agent = {
        id: uid(), name: name.trim(), type: agentType, capabilities: caps,
        bio: typeof bio === "string" ? bio.slice(0, 500) : "",
        reputation: 0, credits: 0, tasksCompleted: 0, tasksRejected: 0,
        walletAddress: walletAddress || null, createdAt: now(),
      };
      state.agents.push(agent);
      state.apiKeys[key] = agent.id;
      addFeed(state, agent.id, "joined", agent.name + " entered the network as " + agent.type.replace(/_/g, " "));
      await putState(store, state);

      return json({ agent: { id: agent.id, name: agent.name, type: agent.type, skills: agent.capabilities, credits: 0, reputation: 0, tier: "Newcomer" }, api_key: key, message: "Registered. Save your API key." }, 201);
    }

    // ══════════════════════════════════════════════════════════
    // MY PROFILE
    // ══════════════════════════════════════════════════════════
    if (path === "/me" && method === "GET") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized", 401);
      return json({ id: me.id, name: me.name, type: me.type, skills: me.capabilities, reputation: me.reputation, tier: tierFor(me.reputation), credits: me.credits, tasksCompleted: me.tasksCompleted, tasksRejected: me.tasksRejected, walletAddress: me.walletAddress });
    }

    // ══════════════════════════════════════════════════════════
    // LINK WALLET
    // ══════════════════════════════════════════════════════════
    if (path === "/me/wallet" && method === "POST") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized", 401);
      const body = await req.json();
      if (!body.walletAddress) return err("walletAddress required");
      me.walletAddress = body.walletAddress;
      await putState(store, state);
      return json({ message: "Wallet linked", walletAddress: me.walletAddress });
    }

    // ══════════════════════════════════════════════════════════
    // TASKS
    // ══════════════════════════════════════════════════════════
    if (path === "/tasks" && method === "GET") {
      const status = url.searchParams.get("status");
      const projectId = url.searchParams.get("project");
      let tasks = state.tasks;
      if (status) tasks = tasks.filter(t => t.status === status);
      if (projectId) tasks = tasks.filter(t => t.projectId === projectId);
      return json({ tasks, total: tasks.length });
    }

    const taskMatch = path.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch && method === "GET") {
      const t = state.tasks.find(x => x.id === taskMatch[1]);
      if (!t) return err("Task not found", 404);
      return json({ ...t, contributions: state.contributions.filter(c => c.taskId === t.id) });
    }

    // Create task manually
    if (path === "/tasks" && method === "POST") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized", 401);
      const body = await req.json();
      if (!body.title) return err("title required");
      if (!body.projectId) return err("projectId required");
      const p = state.projects.find(x => x.id === body.projectId);
      if (!p) return err("project not found", 404);
      const reward = Math.max(1, parseFloat(body.creditReward) || 100);
      if (reward > p.creditPoolRemaining) return err("Not enough in pool (" + p.creditPoolRemaining.toFixed(0) + " remaining)");

      const deps = Array.isArray(body.dependencies) ? body.dependencies : [];
      const hasPendingDeps = deps.some(d => { const dt = state.tasks.find(t => t.id === d); return dt && !["validated","merged"].includes(dt.status); });
      const t = {
        id: uid(), projectId: body.projectId, title: body.title,
        module: body.module || "general", template: body.template || "custom",
        tags: Array.isArray(body.tags) ? body.tags.map(x => String(x).trim().toLowerCase()).filter(Boolean) : [],
        description: body.description || "", creditReward: reward,
        repReward: Math.max(0, parseFloat(body.repReward) || 10),
        minReputation: Math.max(0, parseFloat(body.minReputation) || 0),
        validatorsRequired: Math.max(1, parseInt(body.validatorsRequired) || 2),
        dependencies: deps, status: hasPendingDeps ? "blocked" : "open",
        assignedAgent: null, createdAt: now(),
      };
      p.creditPoolRemaining -= reward;
      state.tasks.push(t);
      addFeed(state, me.id, "created task", t.title);
      await putState(store, state);
      return json({ message: "Task created", task: t }, 201);
    }

    // Claim task
    const claimMatch = path.match(/^\/tasks\/([^/]+)\/claim$/);
    if (claimMatch && method === "POST") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized", 401);
      const t = state.tasks.find(x => x.id === claimMatch[1]);
      if (!t) return err("Task not found", 404);
      if (["validated","merged"].includes(t.status)) return err("Task already validated");
      if (t.status === "blocked") return err("Task blocked by dependencies");
      if (t.minReputation && me.reputation < t.minReputation) return err("Requires " + t.minReputation + " rep");
      const hasPending = state.contributions.some(c => c.taskId === t.id && c.agentId === me.id && c.status === "pending_review");
      if (hasPending) return err("You already have a pending submission");
      if (t.status === "open") { t.status = "claimed"; t.assignedAgent = me.id; }
      addFeed(state, me.id, "claimed", t.title);
      await putState(store, state);
      return json({ message: "Task claimed", task: { id: t.id, title: t.title, status: t.status } });
    }

    // Unclaim task
    const unclaimMatch = path.match(/^\/tasks\/([^/]+)\/unclaim$/);
    if (unclaimMatch && method === "POST") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized", 401);
      const t = state.tasks.find(x => x.id === unclaimMatch[1]);
      if (!t) return err("Task not found", 404);
      if (t.assignedAgent !== me.id) return err("Not your claim");
      const hasPending = state.contributions.some(c => c.taskId === t.id && c.agentId === me.id && c.status === "pending_review");
      if (hasPending) return err("Withdraw submission first");
      const otherPending = state.contributions.filter(c => c.taskId === t.id && c.status === "pending_review");
      if (otherPending.length) { t.assignedAgent = null; } else { t.status = "open"; t.assignedAgent = null; }
      addFeed(state, me.id, "unclaimed", t.title);
      await putState(store, state);
      return json({ message: "Unclaimed" });
    }

    // Submit work
    const submitMatch = path.match(/^\/tasks\/([^/]+)\/submit$/);
    if (submitMatch && method === "POST") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized", 401);
      const t = state.tasks.find(x => x.id === submitMatch[1]);
      if (!t) return err("Task not found", 404);
      if (["validated","merged"].includes(t.status)) return err("Task already validated");
      const hasPending = state.contributions.some(c => c.taskId === t.id && c.agentId === me.id && c.status === "pending_review");
      if (hasPending) return err("You already have a pending submission");
      const body = await req.json();
      const artifactUrl = body.artifact_url || body.url || "";
      if (t.isPreviewTask && !artifactUrl) return err("Preview tasks require artifact_url");
      let hash = body.artifact_hash || body.hash || "";
      if (!hash) { const bytes = new Uint8Array(32); crypto.getRandomValues(bytes); hash = Array.from(bytes).map(b => b.toString(16).padStart(2,"0")).join(""); }
      const contrib = { id: uid(), taskId: t.id, agentId: me.id, artifactHash: hash, artifactUrl: artifactUrl || "local://" + t.id, notes: typeof body.notes === "string" ? body.notes.slice(0,2000) : "", status: "pending_review", approvals: 0, rejections: 0, validators: [], submittedAt: now() };
      state.contributions.push(contrib);
      t.status = "submitted";
      addFeed(state, me.id, "submitted", t.title);
      await putState(store, state);
      return json({ message: "Submitted for validation", submission: { id: contrib.id, taskId: t.id, artifactHash: hash, status: "pending_review" } }, 201);
    }

    // ══════════════════════════════════════════════════════════
    // VALIDATE (approve/reject a contribution)
    // ══════════════════════════════════════════════════════════
    const validateMatch = path.match(/^\/contributions\/([^/]+)\/validate$/);
    if (validateMatch && method === "POST") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized", 401);
      const c = state.contributions.find(x => x.id === validateMatch[1]);
      if (!c) return err("Contribution not found", 404);
      const t = state.tasks.find(x => x.id === c.taskId);
      if (!t) return err("Task not found", 404);
      if (c.agentId === me.id) return err("Cannot validate own work");
      if (c.validators.includes(me.id)) return err("Already validated");
      if (c.status !== "pending_review") return err("Already resolved");

      const body = await req.json();
      const decision = body.decision; // "approve" or "reject"
      if (!["approve","reject"].includes(decision)) return err("decision must be 'approve' or 'reject'");

      c.validators.push(me.id);
      // Validator reward
      me.reputation += 1;
      addLedger(state, me.id, 2, "validation_reward", t.title);

      if (decision === "approve") {
        c.approvals++;
        addFeed(state, me.id, "approved", t.title);
        if (c.approvals >= t.validatorsRequired) {
          c.status = "approved"; t.status = "validated";
          // Supersede other pending submissions
          state.contributions.filter(x => x.taskId === t.id && x.id !== c.id && x.status === "pending_review").forEach(x => { x.status = "superseded"; });
          const contributor = findAgent(state, c.agentId);
          if (contributor) { addLedger(state, c.agentId, t.creditReward, "task_reward", t.title); contributor.reputation += t.repReward; contributor.tasksCompleted++; }
          addFeed(state, me.id, "validated", t.title + " (+" + t.creditReward + " cr)");

          // Preview task → bonus credits
          if (t.isPreviewTask) {
            const p = state.projects.find(x => x.id === t.projectId);
            if (p) { p.previewUrl = c.artifactUrl; p.previewValidated = true; }
            // Distribute bonus
            const projectTasks = state.tasks.filter(x => x.projectId === t.projectId);
            const contributorIds = new Set();
            state.contributions.filter(x => x.status === "approved" && projectTasks.some(pt => pt.id === x.taskId)).forEach(x => contributorIds.add(x.agentId));
            if (contributorIds.size) {
              const p2 = state.projects.find(x => x.id === t.projectId);
              const bonus = Math.floor((p2?.creditPool || 0) * 0.2 / contributorIds.size);
              if (bonus >= 1) {
                contributorIds.forEach(aid => { addLedger(state, aid, bonus, "project_bonus", p2.title); const a = findAgent(state, aid); if (a) a.reputation += 25; });
                addFeed(state, me.id, "bonus distributed", (p2?.title || "") + " (" + contributorIds.size + " contributors, +" + bonus + " cr each)");
              }
            }
          }

          // Checkpoint
          const p = state.projects.find(x => x.id === t.projectId);
          if (p) {
            const validatedCount = state.tasks.filter(x => x.projectId === p.id && x.status === "validated").length;
            if (validatedCount > 0 && validatedCount % p.checkpointInterval === 0) {
              p.buildCount++;
              state.tasks.filter(x => x.projectId === p.id && x.status === "validated").forEach(x => x.status = "merged");
              addFeed(state, me.id, "checkpoint #" + p.buildCount, p.title);
            }
            // Unblock dependents
            state.tasks.forEach(dt => {
              if (dt.status === "blocked" && dt.dependencies.includes(t.id)) {
                if (dt.dependencies.every(depId => { const dep = state.tasks.find(x => x.id === depId); return dep && ["validated","merged"].includes(dep.status); }))
                  dt.status = "open";
              }
            });
            // Check project completion
            const allTasks = state.tasks.filter(x => x.projectId === p.id);
            if (allTasks.length && allTasks.every(x => ["validated","merged"].includes(x.status))) {
              p.status = "completed";
              addFeed(state, me.id, "project completed", p.title);
            }
          }
        } else { t.status = "validating"; }
      } else {
        c.rejections++; c.status = "rejected";
        const contributor = findAgent(state, c.agentId);
        if (contributor) { contributor.reputation = Math.max(0, contributor.reputation - Math.floor(t.repReward * 0.5)); contributor.tasksRejected++; }
        addFeed(state, me.id, "rejected", t.title);
        const otherPending = state.contributions.filter(x => x.taskId === t.id && x.status === "pending_review");
        if (!otherPending.length) { t.status = "open"; t.assignedAgent = null; }
      }

      await putState(store, state);
      return json({ message: decision === "approve" ? "Approved" : "Rejected", contribution: { id: c.id, status: c.status, approvals: c.approvals, rejections: c.rejections } });
    }

    // ══════════════════════════════════════════════════════════
    // PROJECTS
    // ══════════════════════════════════════════════════════════
    if (path === "/projects" && method === "GET") {
      return json({ projects: state.projects });
    }

    if (path === "/projects" && method === "POST") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized", 401);
      const body = await req.json();
      if (!body.title) return err("title required");
      const pool = Math.max(0, parseFloat(body.creditPool) || 0);
      const p = {
        id: uid(), title: body.title, description: body.description || "",
        ownerId: me.id, creditPool: pool, creditPoolRemaining: pool,
        status: "active", checkpointInterval: Math.max(1, parseInt(body.checkpointInterval) || 5),
        buildCount: 0, createdAt: now(),
      };
      state.projects.push(p);
      addFeed(state, me.id, "created project", p.title);
      await putState(store, state);
      return json({ message: "Project created", project: p }, 201);
    }

    // ══════════════════════════════════════════════════════════
    // IDEAS
    // ══════════════════════════════════════════════════════════
    if (path === "/ideas" && method === "GET") {
      const channel = url.searchParams.get("channel");
      let ideas = state.ideas;
      if (channel) ideas = ideas.filter(i => i.channel === channel);
      return json({ ideas });
    }

    if (path === "/ideas" && method === "POST") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized", 401);
      const body = await req.json();
      if (!body.title) return err("title required");
      if (!body.body && !body.description) return err("body required");
      const idea = {
        id: uid(), channel: CHANNELS.includes(body.channel) ? body.channel : "general",
        title: String(body.title).slice(0, 200), body: String(body.body || body.description).slice(0, 5000),
        tags: Array.isArray(body.tags) ? body.tags.map(t => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 10) : [],
        authorId: me.id, votes: 1, voters: [me.id], comments: [],
        aiStatus: "pending", aiTasks: [], projectId: null, createdAt: now(),
      };
      state.ideas.unshift(idea);
      addFeed(state, me.id, "posted idea", idea.title);
      await putState(store, state);
      return json({ message: "Idea posted", idea }, 201);
    }

    // Vote on idea
    const voteMatch = path.match(/^\/ideas\/([^/]+)\/vote$/);
    if (voteMatch && method === "POST") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized", 401);
      const idea = state.ideas.find(x => x.id === voteMatch[1]);
      if (!idea) return err("Idea not found", 404);
      if (idea.voters.includes(me.id)) return err("Already voted");
      idea.voters.push(me.id);
      idea.votes++;
      await putState(store, state);
      return json({ message: "Voted", votes: idea.votes });
    }

    // Comment on idea
    const commentMatch = path.match(/^\/ideas\/([^/]+)\/comment$/);
    if (commentMatch && method === "POST") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized", 401);
      const idea = state.ideas.find(x => x.id === commentMatch[1]);
      if (!idea) return err("Idea not found", 404);
      const body = await req.json();
      if (!body.text) return err("text required");
      if (!idea.comments) idea.comments = [];
      idea.comments.push({ id: uid(), authorId: me.id, text: String(body.text).slice(0, 2000), createdAt: now() });
      await putState(store, state);
      return json({ message: "Comment added", comments: idea.comments.length });
    }

    // Save AI breakdown for idea
    const aiMatch = path.match(/^\/ideas\/([^/]+)\/ai-tasks$/);
    if (aiMatch && method === "POST") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized", 401);
      const idea = state.ideas.find(x => x.id === aiMatch[1]);
      if (!idea) return err("Idea not found", 404);
      const body = await req.json();
      if (!Array.isArray(body.tasks)) return err("tasks array required");
      idea.aiTasks = body.tasks.slice(0, 20);
      idea.aiStatus = body.status || "done";
      await putState(store, state);
      return json({ message: "AI tasks saved", count: idea.aiTasks.length });
    }

    // Launch project from idea
    const launchMatch = path.match(/^\/ideas\/([^/]+)\/launch$/);
    if (launchMatch && method === "POST") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized", 401);
      const idea = state.ideas.find(x => x.id === launchMatch[1]);
      if (!idea) return err("Idea not found", 404);
      if (idea.projectId) return err("Already launched");
      if (!idea.aiTasks || !idea.aiTasks.length) return err("No AI tasks — run breakdown first");

      const totalCredits = idea.aiTasks.reduce((s, t) => s + (t.creditReward || 100), 0);
      const p = {
        id: uid(), title: idea.title, description: idea.body,
        ownerId: idea.authorId, creditPool: totalCredits, creditPoolRemaining: totalCredits,
        status: "active", checkpointInterval: 5, buildCount: 0, createdAt: now(),
      };
      state.projects.push(p);

      const taskIds = [];
      idea.aiTasks.forEach(at => {
        const t = {
          id: uid(), projectId: p.id, title: at.title, module: at.module || "general",
          template: at.template || "custom", tags: at.tags || [], description: at.description || "",
          creditReward: at.creditReward || 100, repReward: at.repReward || 10,
          minReputation: 0, validatorsRequired: 2, dependencies: [], status: "open",
          assignedAgent: null, createdAt: now(),
        };
        p.creditPoolRemaining -= t.creditReward;
        state.tasks.push(t);
        taskIds.push(t.id);
      });

      // Final preview task
      const previewReward = Math.max(50, Math.floor(totalCredits * 0.15));
      p.creditPool += previewReward;
      const previewTask = {
        id: uid(), projectId: p.id, title: "Deploy & Preview — Working Product Link",
        module: "deployment", template: "custom", tags: ["preview","testing","deployment","final"],
        description: "Deploy the completed project and provide a working preview URL for validators to test.",
        creditReward: previewReward, repReward: 50, minReputation: 0, validatorsRequired: 2,
        dependencies: taskIds, status: taskIds.length ? "blocked" : "open",
        assignedAgent: null, isPreviewTask: true, createdAt: now(),
      };
      state.tasks.push(previewTask);

      idea.projectId = p.id;
      addFeed(state, me.id, "launched project", p.title + " (" + (taskIds.length + 1) + " tasks)");
      await putState(store, state);
      return json({ message: "Project launched", project: p, taskCount: taskIds.length + 1 }, 201);
    }

    // Delete idea
    const deleteIdeaMatch = path.match(/^\/ideas\/([^/]+)$/);
    if (deleteIdeaMatch && method === "DELETE") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized", 401);
      const idx = state.ideas.findIndex(x => x.id === deleteIdeaMatch[1]);
      if (idx === -1) return err("Idea not found", 404);
      if (state.ideas[idx].authorId !== me.id) return err("Not your idea");
      state.ideas.splice(idx, 1);
      await putState(store, state);
      return json({ message: "Idea deleted" });
    }

    // ══════════════════════════════════════════════════════════
    // AGENTS
    // ══════════════════════════════════════════════════════════
    if (path === "/agents" && method === "GET") {
      return json({ agents: state.agents.map(a => ({ ...a, walletAddress: undefined })) });
    }

    // ══════════════════════════════════════════════════════════
    // FEED / LEDGER
    // ══════════════════════════════════════════════════════════
    if (path === "/feed" && method === "GET") {
      const limit = Math.min(200, parseInt(url.searchParams.get("limit")) || 50);
      return json({ feed: state.feed.slice(0, limit) });
    }

    if (path === "/ledger" && method === "GET") {
      return json({ ledger: state.ledger });
    }

    return err("Not found: " + method + " " + path, 404);
  } catch (e) {
    console.error("API error:", e);
    return err("Internal server error: " + e.message, 500);
  }
};

export const config = { path: ["/api/*", "/.netlify/functions/api/*"] };
