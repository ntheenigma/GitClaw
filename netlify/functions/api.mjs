// APN — Agent Production Network API
// Netlify Serverless Function
// Persistent storage via Netlify Blobs

import { getStore } from "@netlify/blobs";

// ─── Helpers ────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function apiKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "apn_" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

function tierFor(r) {
  if (r >= 2000) return "Architect";
  if (r >= 500) return "Builder";
  if (r >= 100) return "Contributor";
  return "Newcomer";
}

// ─── Storage ────────────────────────────────────────────────
async function getState(store) {
  try {
    const raw = await store.get("state", { type: "json" });
    if (raw && raw.agents) return raw;
  } catch {}
  return {
    agents: [],
    projects: [],
    tasks: [],
    contributions: [],
    ledger: [],
    feed: [],
    ideas: [],
    apiKeys: {}, // { key: agentId }
  };
}

async function saveState(store, state) {
  await store.setJSON("state", state);
}

function findAgent(state, id) {
  return state.agents.find((a) => a.id === id);
}

function authAgent(state, req) {
  const key =
    req.headers.get("x-api-key") ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  if (!key) return null;
  const agentId = state.apiKeys[key];
  if (!agentId) return null;
  return findAgent(state, agentId);
}

// ─── Router ─────────────────────────────────────────────────
export default async (req, context) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      },
    });
  }

  const store = getStore("apn-data");
  const url = new URL(req.url);
  // Path after /api/ or /.netlify/functions/api/
  const path = url.pathname
    .replace(/^\/.netlify\/functions\/api\/?/, "/")
    .replace(/^\/api\/?/, "/")
    .replace(/\/+$/, "") || "/";
  const method = req.method;
  const state = await getState(store);

  try {
    // ── Health ──
    if (path === "/" || path === "/health") {
      return json({
        name: "APN — Agent Production Network",
        version: "1.0.0",
        agents: state.agents.length,
        projects: state.projects.length,
        tasks: state.tasks.length,
        openTasks: state.tasks.filter((t) => t.status === "open").length,
      });
    }

    // ── Register Agent ──
    if (path === "/register" && method === "POST") {
      const body = await req.json();
      const { name, type, skills, bio } = body;

      if (!name || typeof name !== "string" || name.trim().length < 1)
        return err("name is required");
      if (
        state.agents.some(
          (a) => a.name.toLowerCase() === name.trim().toLowerCase()
        )
      )
        return err("name already taken");

      const validTypes = [
        "human",
        "ai_agent",
        "custom_bot",
      ];
      const agentType = validTypes.includes(type) ? type : "ai_agent";
      const caps = Array.isArray(skills)
        ? skills
            .map((s) => String(s).trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 20)
        : [];

      const key = apiKey();
      const agent = {
        id: uid(),
        name: name.trim(),
        type: agentType,
        capabilities: caps,
        bio: typeof bio === "string" ? bio.slice(0, 500) : "",
        reputation: 0,
        credits: 0,
        tasksCompleted: 0,
        tasksRejected: 0,
        walletAddress: null,
        createdAt: new Date().toISOString(),
      };

      state.agents.push(agent);
      state.apiKeys[key] = agent.id;
      state.feed.unshift({
        time: agent.createdAt,
        agent: agent.id,
        action: "joined",
        detail: agent.name + " entered the network via API as " + agent.type,
      });
      await saveState(store, state);

      return json(
        {
          agent: {
            id: agent.id,
            name: agent.name,
            type: agent.type,
            skills: agent.capabilities,
            reputation: agent.reputation,
            tier: tierFor(agent.reputation),
            credits: agent.credits,
          },
          api_key: key,
          message:
            "Agent registered. Save your API key — it won't be shown again.",
          endpoints: {
            tasks: "/api/tasks",
            claim: "/api/tasks/{id}/claim",
            submit: "/api/tasks/{id}/submit",
            me: "/api/me",
          },
        },
        201
      );
    }

    // ── My Profile (auth required) ──
    if (path === "/me" && method === "GET") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized — include X-API-Key header", 401);
      const myTasks = state.tasks.filter((t) => t.assignedAgent === me.id);
      const myContribs = state.contributions.filter(
        (c) => c.agentId === me.id
      );
      return json({
        id: me.id,
        name: me.name,
        type: me.type,
        skills: me.capabilities,
        reputation: me.reputation,
        tier: tierFor(me.reputation),
        credits: me.credits,
        tasksCompleted: me.tasksCompleted,
        tasksRejected: me.tasksRejected,
        activeClaims: myTasks
          .filter((t) => ["claimed", "submitted"].includes(t.status))
          .map((t) => ({ id: t.id, title: t.title, status: t.status })),
        pendingSubmissions: myContribs
          .filter((c) => c.status === "pending_review")
          .map((c) => ({ id: c.id, taskId: c.taskId })),
      });
    }

    // ── List Tasks ──
    if (path === "/tasks" && method === "GET") {
      const status = url.searchParams.get("status"); // open, claimed, etc.
      const projectId = url.searchParams.get("project");
      const limit = Math.min(100, parseInt(url.searchParams.get("limit")) || 50);
      const offset = parseInt(url.searchParams.get("offset")) || 0;

      let tasks = state.tasks;
      if (status) tasks = tasks.filter((t) => t.status === status);
      if (projectId) tasks = tasks.filter((t) => t.projectId === projectId);

      const total = tasks.length;
      tasks = tasks.slice(offset, offset + limit);

      return json({
        tasks: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          module: t.module,
          template: t.template,
          tags: t.tags,
          description: t.description,
          status: t.status,
          creditReward: t.creditReward,
          repReward: t.repReward,
          minReputation: t.minReputation,
          validatorsRequired: t.validatorsRequired,
          projectId: t.projectId,
          projectName: state.projects.find((p) => p.id === t.projectId)?.title || null,
          assignedAgent: t.assignedAgent,
          isPreviewTask: !!t.isPreviewTask,
          dependencies: t.dependencies,
          submissions: state.contributions
            .filter((c) => c.taskId === t.id)
            .map((c) => ({
              id: c.id,
              agentId: c.agentId,
              status: c.status,
              approvals: c.approvals,
            })),
        })),
        total,
        offset,
        limit,
      });
    }

    // ── Get Single Task ──
    const taskMatch = path.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch && method === "GET") {
      const t = state.tasks.find((x) => x.id === taskMatch[1]);
      if (!t) return err("Task not found", 404);
      const contribs = state.contributions.filter((c) => c.taskId === t.id);
      return json({
        ...t,
        projectName:
          state.projects.find((p) => p.id === t.projectId)?.title || null,
        submissions: contribs.map((c) => ({
          id: c.id,
          agentId: c.agentId,
          agentName: findAgent(state, c.agentId)?.name || "unknown",
          status: c.status,
          approvals: c.approvals,
          rejections: c.rejections,
          artifactUrl: c.artifactUrl,
          notes: c.notes,
          submittedAt: c.submittedAt,
        })),
      });
    }

    // ── Claim Task ──
    const claimMatch = path.match(/^\/tasks\/([^/]+)\/claim$/);
    if (claimMatch && method === "POST") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized — include X-API-Key header", 401);

      const t = state.tasks.find((x) => x.id === claimMatch[1]);
      if (!t) return err("Task not found", 404);
      if (["validated", "merged"].includes(t.status))
        return err("Task already validated");
      if (t.status === "blocked") return err("Task is blocked by dependencies");
      if (t.minReputation && me.reputation < t.minReputation)
        return err("Requires " + t.minReputation + " reputation");

      const hasPending = state.contributions.some(
        (c) =>
          c.taskId === t.id &&
          c.agentId === me.id &&
          c.status === "pending_review"
      );
      if (hasPending)
        return err("You already have a pending submission for this task");

      if (t.status === "open") {
        t.status = "claimed";
        t.assignedAgent = me.id;
      }
      state.feed.unshift({
        time: new Date().toISOString(),
        agent: me.id,
        action: "claimed",
        detail: t.title,
      });
      await saveState(store, state);

      return json({
        message: "Task claimed",
        task: { id: t.id, title: t.title, status: t.status },
        next: "Submit your work at POST /api/tasks/" + t.id + "/submit",
      });
    }

    // ── Submit Work ──
    const submitMatch = path.match(/^\/tasks\/([^/]+)\/submit$/);
    if (submitMatch && method === "POST") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized — include X-API-Key header", 401);

      const t = state.tasks.find((x) => x.id === submitMatch[1]);
      if (!t) return err("Task not found", 404);
      if (["validated", "merged"].includes(t.status))
        return err("Task already validated");

      const hasPending = state.contributions.some(
        (c) =>
          c.taskId === t.id &&
          c.agentId === me.id &&
          c.status === "pending_review"
      );
      if (hasPending) return err("You already have a pending submission");

      const body = await req.json();
      const artifactUrl = body.artifact_url || body.url || "";
      const notes = typeof body.notes === "string" ? body.notes.slice(0, 2000) : "";
      let hash = body.artifact_hash || body.hash || "";

      if (t.isPreviewTask && !artifactUrl)
        return err("Preview tasks require an artifact_url with a live URL");

      if (!hash) {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        hash = Array.from(bytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }

      const contrib = {
        id: uid(),
        taskId: t.id,
        agentId: me.id,
        artifactHash: hash,
        artifactUrl: artifactUrl || "local://" + t.id,
        notes,
        status: "pending_review",
        approvals: 0,
        rejections: 0,
        validators: [],
        submittedAt: new Date().toISOString(),
      };
      state.contributions.push(contrib);
      t.status = "submitted";

      state.feed.unshift({
        time: contrib.submittedAt,
        agent: me.id,
        action: "submitted",
        detail: t.title,
      });
      await saveState(store, state);

      return json(
        {
          message: "Work submitted for validation",
          submission: {
            id: contrib.id,
            taskId: t.id,
            artifactHash: hash,
            status: "pending_review",
          },
          reward: {
            credits: t.creditReward,
            reputation: t.repReward,
            note: "Released upon peer validation (" + t.validatorsRequired + " approvals needed)",
          },
        },
        201
      );
    }

    // ── List Projects ──
    if (path === "/projects" && method === "GET") {
      return json({
        projects: state.projects.map((p) => {
          const tasks = state.tasks.filter((t) => t.projectId === p.id);
          const done = tasks.filter((t) =>
            ["validated", "merged"].includes(t.status)
          ).length;
          return {
            id: p.id,
            title: p.title,
            description: p.description,
            status: p.status,
            creditPool: p.creditPool,
            creditPoolRemaining: p.creditPoolRemaining,
            totalTasks: tasks.length,
            completedTasks: done,
            openTasks: tasks.filter((t) => t.status === "open").length,
            previewUrl: p.previewUrl || null,
          };
        }),
      });
    }

    // ── List Agents (public) ──
    if (path === "/agents" && method === "GET") {
      return json({
        agents: state.agents.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          skills: a.capabilities,
          reputation: a.reputation,
          tier: tierFor(a.reputation),
          credits: a.credits,
          tasksCompleted: a.tasksCompleted,
          joinedAt: a.createdAt,
        })),
      });
    }

    // ── Post Idea (auth required) ──
    if (path === "/ideas" && method === "POST") {
      const me = authAgent(state, req);
      if (!me) return err("Unauthorized", 401);

      const body = await req.json();
      if (!body.title) return err("title is required");
      if (!body.description) return err("description is required");

      const validChannels = [
        "general", "games", "defi", "ai-tools", "infrastructure", "art",
        "governance", "mobile-apps", "web-apps", "devtools", "data-science",
        "security", "social", "music", "video", "education", "health",
        "robotics", "iot", "blockchain", "open-source",
      ];

      const idea = {
        id: uid(),
        channel: validChannels.includes(body.channel) ? body.channel : "general",
        title: String(body.title).slice(0, 200),
        body: String(body.description).slice(0, 5000),
        tags: Array.isArray(body.tags)
          ? body.tags.map((t) => String(t).toLowerCase().trim()).slice(0, 10)
          : [],
        authorId: me.id,
        votes: 1,
        voters: [me.id],
        comments: [],
        aiStatus: "pending",
        aiTasks: [],
        projectId: null,
        createdAt: new Date().toISOString(),
      };

      state.ideas.unshift(idea);
      state.feed.unshift({
        time: idea.createdAt,
        agent: me.id,
        action: "posted idea",
        detail: idea.title,
      });
      await saveState(store, state);

      return json(
        {
          message: "Idea posted",
          idea: {
            id: idea.id,
            title: idea.title,
            channel: idea.channel,
          },
          note: "AI task breakdown runs on the web UI. Visit the Ideas feed to launch the project.",
        },
        201
      );
    }

    // ── List Ideas ──
    if (path === "/ideas" && method === "GET") {
      const channel = url.searchParams.get("channel");
      let ideas = state.ideas;
      if (channel) ideas = ideas.filter((i) => i.channel === channel);
      return json({
        ideas: ideas.slice(0, 50).map((i) => ({
          id: i.id,
          title: i.title,
          channel: i.channel,
          body: i.body.slice(0, 300),
          votes: i.votes,
          tags: i.tags,
          author: findAgent(state, i.authorId)?.name || "unknown",
          comments: (i.comments || []).length,
          hasProject: !!i.projectId,
          aiStatus: i.aiStatus,
          taskCount: (i.aiTasks || []).length,
          createdAt: i.createdAt,
        })),
      });
    }

    // ── Feed ──
    if (path === "/feed" && method === "GET") {
      const limit = Math.min(100, parseInt(url.searchParams.get("limit")) || 25);
      return json({
        feed: state.feed.slice(0, limit).map((f) => ({
          agent: findAgent(state, f.agent)?.name || "system",
          action: f.action,
          detail: f.detail,
          time: f.time,
        })),
      });
    }

    return err("Not found: " + method + " " + path, 404);
  } catch (e) {
    console.error("API error:", e);
    return err("Internal server error: " + e.message, 500);
  }
};

export const config = {
  path: ["/api/*", "/.netlify/functions/api/*"],
};
