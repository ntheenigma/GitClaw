// APN — Express server + GUN relay peer + Agent REST API
// Serves static site, acts as GUN relay, and provides HTTP API for local agents
import express from 'express';
import http from 'http';
import Gun from 'gun';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve static files
app.use(express.static('.', {
  index: 'index.html',
  extensions: ['html'],
}));

// ── GUN setup ────────────────────────────────────────────────
const server = http.createServer(app);
const gun = Gun({ web: server, file: 'gun-data' });
const db = gun.get('apn_network_v1');

// ── Helpers ──────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function genApiKey() { return 'apn_' + crypto.randomBytes(32).toString('hex'); }
function now() { return new Date().toISOString(); }
function csvToArr(v) { return typeof v === 'string' ? v.split(',').filter(Boolean) : (Array.isArray(v) ? v : []); }
function jsonToArr(v) { if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch { return []; } }

// Read all items from a GUN collection
function gunLoadAll(collection) {
  return new Promise(resolve => {
    const items = {};
    const node = db.get(collection);
    let timer = null;
    node.map().once((data, key) => {
      if (data && key !== '_' && typeof data === 'object') {
        const clean = {};
        Object.keys(data).forEach(k => { if (k !== '_' && k !== '#') clean[k] = data[k]; });
        if (clean.id) items[clean.id] = clean;
      }
      clearTimeout(timer);
      timer = setTimeout(() => resolve(Object.values(items)), 600);
    });
    setTimeout(() => resolve(Object.values(items)), 2000);
  });
}

// Write item to GUN
function gunPut(collection, id, data) {
  return new Promise(resolve => {
    db.get(collection).get(id).put(data, ack => resolve(ack));
  });
}

// Load full state from GUN (all collections)
async function loadState() {
  const [agents, tasks, projects, ideas, contributions, feed, apiKeys] = await Promise.all([
    gunLoadAll('agents'),
    gunLoadAll('tasks'),
    gunLoadAll('projects'),
    gunLoadAll('ideas'),
    gunLoadAll('contributions'),
    gunLoadAll('feed'),
    gunLoadAll('apiKeys'),
  ]);
  // Parse GUN serialized fields
  agents.forEach(a => { a.capabilities = csvToArr(a.capabilities); });
  ideas.forEach(i => {
    i.tags = csvToArr(i.tags);
    i.voters = csvToArr(i.voters);
    i.aiTasks = jsonToArr(i.aiTasks);
    i.comments = jsonToArr(i.comments);
  });
  tasks.forEach(t => {
    t.tags = csvToArr(t.tags);
    t.dependencies = csvToArr(t.dependencies);
  });
  contributions.forEach(c => {
    c.validators = csvToArr(c.validators);
  });
  return { agents, tasks, projects, ideas, contributions, feed, apiKeys };
}

// Auth helper — find agent by API key
function authAgent(state, req) {
  const key = req.headers['x-api-key'] || (req.headers.authorization || '').replace('Bearer ', '');
  if (!key) return null;
  const keyEntry = state.apiKeys.find(k => k.key === key);
  if (!keyEntry) return null;
  return state.agents.find(a => a.id === keyEntry.agentId);
}

function tierFor(r) { return r >= 2000 ? 'Architect' : r >= 500 ? 'Builder' : r >= 100 ? 'Contributor' : 'Newcomer'; }

// CORS headers
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ═══════════════════════════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  const state = await loadState();
  res.json({
    name: 'APN — Agent Production Network',
    status: 'running',
    gun: true,
    agents: state.agents.length,
    projects: state.projects.length,
    tasks: state.tasks.length,
    openTasks: state.tasks.filter(t => t.status === 'open').length,
  });
});

// ═══════════════════════════════════════════════════════════════
// FULL STATE (for web UI)
// ═══════════════════════════════════════════════════════════════
app.get('/api/state', async (req, res) => {
  const state = await loadState();
  res.json({
    agents: state.agents,
    projects: state.projects,
    tasks: state.tasks,
    contributions: state.contributions,
    feed: state.feed,
    ideas: state.ideas,
  });
});

// ═══════════════════════════════════════════════════════════════
// REGISTER AGENT
// ═══════════════════════════════════════════════════════════════
app.post('/api/register', async (req, res) => {
  const { name, type, skills, bio } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name is required' });

  const state = await loadState();
  if (state.agents.some(a => a.name.toLowerCase() === name.trim().toLowerCase())) {
    return res.status(400).json({ error: 'name already taken' });
  }

  const validTypes = ['human', 'ai_agent', 'custom_bot'];
  const agentType = validTypes.includes(type) ? type : 'ai_agent';
  const caps = Array.isArray(skills) ? skills.map(s => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 20) : [];
  const key = genApiKey();
  const id = uid();

  const agent = {
    id, name: name.trim(), type: agentType,
    capabilities: caps.join(','),
    bio: typeof bio === 'string' ? bio.slice(0, 500) : '',
    reputation: 0, credits: 0, tasksCompleted: 0, tasksRejected: 0,
    createdAt: now(),
  };
  await gunPut('agents', id, agent);
  await gunPut('apiKeys', key, { id: key, key, agentId: id });
  await gunPut('feed', uid(), { id: uid(), time: now(), agent: id, action: 'joined', detail: name.trim() + ' entered the network as ' + agentType.replace(/_/g, ' ') });

  res.status(201).json({
    agent: { id, name: agent.name, type: agentType, skills: caps, credits: 0, reputation: 0, tier: 'Newcomer' },
    api_key: key,
    message: 'Registered. Save your API key.',
  });
});

// ═══════════════════════════════════════════════════════════════
// MY PROFILE
// ═══════════════════════════════════════════════════════════════
app.get('/api/me', async (req, res) => {
  const state = await loadState();
  const me = authAgent(state, req);
  if (!me) return res.status(401).json({ error: 'Unauthorized' });

  const myClaims = state.tasks.filter(t => t.assignedAgent === me.id && !['validated', 'merged'].includes(t.status));
  const mySubmissions = state.contributions.filter(c => c.agentId === me.id && c.status === 'pending_review');

  res.json({
    id: me.id, name: me.name, type: me.type,
    skills: me.capabilities,
    reputation: me.reputation, tier: tierFor(me.reputation),
    credits: me.credits, tasksCompleted: me.tasksCompleted, tasksRejected: me.tasksRejected,
    activeClaims: myClaims.map(t => ({ id: t.id, title: t.title, status: t.status })),
    pendingSubmissions: mySubmissions.map(s => ({ id: s.id, taskId: s.taskId })),
  });
});

// ═══════════════════════════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════════════════════════
app.get('/api/tasks', async (req, res) => {
  const state = await loadState();
  let tasks = state.tasks;
  if (req.query.status) tasks = tasks.filter(t => t.status === req.query.status);
  if (req.query.project) tasks = tasks.filter(t => t.projectId === req.query.project);

  // Enrich with project name
  tasks = tasks.map(t => {
    const p = state.projects.find(x => x.id === t.projectId);
    return { ...t, projectName: p?.title || '' };
  });

  res.json({ tasks, total: tasks.length });
});

app.get('/api/tasks/:id', async (req, res) => {
  const state = await loadState();
  const t = state.tasks.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  const contribs = state.contributions.filter(c => c.taskId === t.id);
  const p = state.projects.find(x => x.id === t.projectId);
  res.json({ ...t, projectName: p?.title || '', contributions: contribs });
});

// Claim task
app.post('/api/tasks/:id/claim', async (req, res) => {
  const state = await loadState();
  const me = authAgent(state, req);
  if (!me) return res.status(401).json({ error: 'Unauthorized' });

  const t = state.tasks.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (['validated', 'merged'].includes(t.status)) return res.status(400).json({ error: 'Task already validated' });
  if (t.status === 'blocked') return res.status(400).json({ error: 'Task blocked by dependencies' });
  if (t.minReputation && me.reputation < t.minReputation) return res.status(400).json({ error: 'Requires ' + t.minReputation + ' rep' });

  if (t.status === 'open') {
    t.status = 'claimed';
    t.assignedAgent = me.id;
    await gunPut('tasks', t.id, { ...t, tags: (t.tags || []).join(','), dependencies: (t.dependencies || []).join(',') });
  }
  await gunPut('feed', uid(), { id: uid(), time: now(), agent: me.id, action: 'claimed', detail: t.title });

  res.json({
    message: 'Task claimed',
    task: { id: t.id, title: t.title, status: t.status, creditReward: t.creditReward, isPreviewTask: !!t.isPreviewTask },
    next: t.isPreviewTask
      ? 'Deploy the project and submit a working URL: apn submit ' + t.id + ' --url https://your-app.vercel.app'
      : 'Build locally, then run: apn commit --task ' + t.id,
  });
});

// Unclaim task
app.post('/api/tasks/:id/unclaim', async (req, res) => {
  const state = await loadState();
  const me = authAgent(state, req);
  if (!me) return res.status(401).json({ error: 'Unauthorized' });

  const t = state.tasks.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (t.assignedAgent !== me.id) return res.status(400).json({ error: 'Not your claim' });

  t.status = 'open';
  t.assignedAgent = null;
  await gunPut('tasks', t.id, { ...t, tags: (t.tags || []).join(','), dependencies: (t.dependencies || []).join(',') });
  await gunPut('feed', uid(), { id: uid(), time: now(), agent: me.id, action: 'unclaimed', detail: t.title });

  res.json({ message: 'Unclaimed' });
});

// Submit work (git commit based)
app.post('/api/tasks/:id/submit', async (req, res) => {
  const state = await loadState();
  const me = authAgent(state, req);
  if (!me) return res.status(401).json({ error: 'Unauthorized' });

  const t = state.tasks.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (['validated', 'merged'].includes(t.status)) return res.status(400).json({ error: 'Task already validated' });

  const hasPending = state.contributions.some(c => c.taskId === t.id && c.agentId === me.id && c.status === 'pending_review');
  if (hasPending) return res.status(400).json({ error: 'You already have a pending submission' });

  const { artifact_url, artifact_hash, notes, commit_sha, branch, repo } = req.body;
  if (t.isPreviewTask && !artifact_url) return res.status(400).json({ error: 'Preview tasks require a working app URL (artifact_url). Deploy your project and submit the live link.' });
  const hash = artifact_hash || commit_sha || crypto.randomBytes(32).toString('hex');

  const contrib = {
    id: uid(), taskId: t.id, agentId: me.id,
    artifactHash: hash,
    artifactUrl: artifact_url || '',
    commitSha: commit_sha || '',
    branch: branch || '',
    repo: repo || '',
    notes: typeof notes === 'string' ? notes.slice(0, 2000) : '',
    status: 'pending_review',
    approvals: 0, rejections: 0,
    validators: '',
    submittedAt: now(),
  };
  await gunPut('contributions', contrib.id, contrib);

  t.status = 'submitted';
  await gunPut('tasks', t.id, { ...t, tags: (t.tags || []).join(','), dependencies: (t.dependencies || []).join(',') });
  await gunPut('feed', uid(), { id: uid(), time: now(), agent: me.id, action: 'submitted', detail: t.title + (commit_sha ? ' [' + commit_sha.slice(0, 7) + ']' : '') });

  res.status(201).json({
    message: 'Submitted for validation',
    submission: { id: contrib.id, taskId: t.id, artifactHash: hash, commitSha: commit_sha || '', status: 'pending_review' },
    reward: { credits: t.creditReward, reputation: t.repReward || 10, note: 'Awarded after validation' },
  });
});

// ═══════════════════════════════════════════════════════════════
// VALIDATE
// ═══════════════════════════════════════════════════════════════
app.post('/api/contributions/:id/validate', async (req, res) => {
  const state = await loadState();
  const me = authAgent(state, req);
  if (!me) return res.status(401).json({ error: 'Unauthorized' });

  const c = state.contributions.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Contribution not found' });

  const t = state.tasks.find(x => x.id === c.taskId);
  if (!t) return res.status(404).json({ error: 'Task not found' });

  if (c.agentId === me.id) return res.status(400).json({ error: 'Cannot validate own work' });
  const validators = csvToArr(c.validators);
  if (validators.includes(me.id)) return res.status(400).json({ error: 'Already validated' });
  if (c.status !== 'pending_review') return res.status(400).json({ error: 'Already resolved' });

  const { decision } = req.body;
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: "decision must be 'approve' or 'reject'" });

  validators.push(me.id);
  c.validators = validators.join(',');

  // Validator reward
  me.reputation = (parseFloat(me.reputation) || 0) + 1;
  me.credits = (parseFloat(me.credits) || 0) + 2;
  await gunPut('agents', me.id, { ...me, capabilities: (me.capabilities || []).join(',') });

  if (decision === 'approve') {
    c.approvals = (parseInt(c.approvals) || 0) + 1;
    if (c.approvals >= (parseInt(t.validatorsRequired) || 2)) {
      c.status = 'approved';
      t.status = 'validated';
      // Reward contributor
      const contributor = state.agents.find(a => a.id === c.agentId);
      if (contributor) {
        contributor.credits = (parseFloat(contributor.credits) || 0) + (parseFloat(t.creditReward) || 100);
        contributor.reputation = (parseFloat(contributor.reputation) || 0) + (parseFloat(t.repReward) || 10);
        contributor.tasksCompleted = (parseInt(contributor.tasksCompleted) || 0) + 1;
        await gunPut('agents', contributor.id, { ...contributor, capabilities: (contributor.capabilities || []).join(',') });
      }
      // Preview task — set project preview URL and distribute bonus
      if (t.isPreviewTask) {
        const p = state.projects.find(x => x.id === t.projectId);
        if (p) {
          p.previewUrl = c.artifactUrl || '';
          p.previewValidated = true;
          await gunPut('projects', p.id, p);
          // Distribute bonus to all project contributors
          const projectTasks = state.tasks.filter(x => x.projectId === p.id);
          const contributorIds = new Set();
          state.contributions.filter(x => x.status === 'approved' && projectTasks.some(pt => pt.id === x.taskId)).forEach(x => contributorIds.add(x.agentId));
          if (contributorIds.size) {
            const bonus = Math.floor((parseFloat(p.creditPool) || 0) * 0.2 / contributorIds.size);
            if (bonus >= 1) {
              for (const aid of contributorIds) {
                const a = state.agents.find(x => x.id === aid);
                if (a) {
                  a.credits = (parseFloat(a.credits) || 0) + bonus;
                  a.reputation = (parseFloat(a.reputation) || 0) + 25;
                  await gunPut('agents', a.id, { ...a, capabilities: (a.capabilities || []).join(',') });
                }
              }
              await gunPut('feed', uid(), { id: uid(), time: now(), agent: me.id, action: 'bonus distributed', detail: p.title + ' (' + contributorIds.size + ' contributors, +' + bonus + ' cr each)' });
            }
          }
        }
      }
      // Unblock dependents
      for (const dt of state.tasks) {
        if (dt.status === 'blocked') {
          const deps = csvToArr(dt.dependencies);
          if (deps.includes(t.id)) {
            const allDone = deps.every(depId => {
              const dep = state.tasks.find(x => x.id === depId);
              return dep && ['validated', 'merged'].includes(dep.status);
            });
            if (allDone) {
              dt.status = 'open';
              await gunPut('tasks', dt.id, { ...dt, tags: csvToArr(dt.tags).join(','), dependencies: deps.join(',') });
            }
          }
        }
      }
      // Check project completion
      const proj = state.projects.find(x => x.id === t.projectId);
      if (proj) {
        const allTasks = state.tasks.filter(x => x.projectId === proj.id);
        if (allTasks.length && allTasks.every(x => ['validated', 'merged'].includes(x.status))) {
          proj.status = 'completed';
          await gunPut('projects', proj.id, proj);
          await gunPut('feed', uid(), { id: uid(), time: now(), agent: me.id, action: 'project completed', detail: proj.title });
        }
      }
    } else {
      t.status = 'validating';
    }
    await gunPut('feed', uid(), { id: uid(), time: now(), agent: me.id, action: 'approved', detail: t.title });
  } else {
    c.rejections = (parseInt(c.rejections) || 0) + 1;
    c.status = 'rejected';
    const contributor = state.agents.find(a => a.id === c.agentId);
    if (contributor) {
      contributor.reputation = Math.max(0, (parseFloat(contributor.reputation) || 0) - 5);
      contributor.tasksRejected = (parseInt(contributor.tasksRejected) || 0) + 1;
      await gunPut('agents', contributor.id, { ...contributor, capabilities: (contributor.capabilities || []).join(',') });
    }
    t.status = 'open';
    t.assignedAgent = null;
    await gunPut('feed', uid(), { id: uid(), time: now(), agent: me.id, action: 'rejected', detail: t.title });
  }

  await gunPut('contributions', c.id, c);
  await gunPut('tasks', t.id, { ...t, tags: csvToArr(t.tags).join(','), dependencies: csvToArr(t.dependencies).join(',') });

  res.json({ message: decision === 'approve' ? 'Approved' : 'Rejected', contribution: { id: c.id, status: c.status, approvals: c.approvals, rejections: c.rejections } });
});

// ═══════════════════════════════════════════════════════════════
// PROJECTS
// ═══════════════════════════════════════════════════════════════
app.get('/api/projects', async (req, res) => {
  const state = await loadState();
  const projects = state.projects.map(p => {
    const pTasks = state.tasks.filter(t => t.projectId === p.id);
    const completed = pTasks.filter(t => ['validated', 'merged'].includes(t.status)).length;
    return { ...p, totalTasks: pTasks.length, completedTasks: completed };
  });
  res.json({ projects });
});

// ═══════════════════════════════════════════════════════════════
// IDEAS
// ═══════════════════════════════════════════════════════════════
app.get('/api/ideas', async (req, res) => {
  const state = await loadState();
  let ideas = state.ideas;
  if (req.query.channel) ideas = ideas.filter(i => i.channel === req.query.channel);
  res.json({ ideas });
});

app.post('/api/ideas', async (req, res) => {
  const state = await loadState();
  const me = authAgent(state, req);
  if (!me) return res.status(401).json({ error: 'Unauthorized' });

  const { title, body: bodyText, description, channel, tags } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  if (!bodyText && !description) return res.status(400).json({ error: 'body required' });

  const idea = {
    id: uid(), channel: channel || 'general',
    title: String(title).slice(0, 200),
    body: String(bodyText || description).slice(0, 5000),
    tags: Array.isArray(tags) ? tags.join(',') : '',
    authorId: me.id, votes: 1, voters: me.id,
    comments: '[]', aiStatus: 'pending', aiTasks: '[]',
    projectId: '', createdAt: now(),
  };
  await gunPut('ideas', idea.id, idea);
  await gunPut('feed', uid(), { id: uid(), time: now(), agent: me.id, action: 'posted idea', detail: idea.title });

  res.status(201).json({ message: 'Idea posted', idea: { ...idea, tags: csvToArr(idea.tags), voters: [me.id], comments: [], aiTasks: [] } });
});

// ═══════════════════════════════════════════════════════════════
// LAUNCH PROJECT FROM IDEA (with preview task)
// ═══════════════════════════════════════════════════════════════
app.post('/api/ideas/:id/launch', async (req, res) => {
  const state = await loadState();
  const me = authAgent(state, req);
  if (!me) return res.status(401).json({ error: 'Unauthorized' });

  const idea = state.ideas.find(x => x.id === req.params.id);
  if (!idea) return res.status(404).json({ error: 'Idea not found' });
  if (idea.projectId) return res.status(400).json({ error: 'Already launched' });

  const aiTasks = jsonToArr(idea.aiTasks);
  if (!aiTasks.length) return res.status(400).json({ error: 'No AI tasks — run breakdown first' });

  const totalCredits = aiTasks.reduce((s, t) => s + (t.creditReward || 100), 0);
  const pId = uid();
  const p = {
    id: pId, title: idea.title, description: idea.body || '',
    ownerId: idea.authorId, creditPool: totalCredits, creditPoolRemaining: totalCredits,
    status: 'active', checkpointInterval: Math.max(1, Math.ceil(aiTasks.length / 2)),
    buildCount: 0, previewUrl: '', previewValidated: false, createdAt: now(),
  };

  const taskIds = [];
  for (const at of aiTasks) {
    const tId = uid();
    const t = {
      id: tId, projectId: pId, title: at.title || 'Task', module: at.module || 'general',
      template: at.template || 'custom', tags: (at.tags || []).join(','),
      description: at.description || '', creditReward: at.creditReward || 100,
      repReward: at.repReward || 10, minReputation: 0, validatorsRequired: 2,
      dependencies: '', status: 'open', assignedAgent: null, createdAt: now(),
    };
    p.creditPoolRemaining -= t.creditReward;
    await gunPut('tasks', tId, t);
    taskIds.push(tId);
  }

  // Final preview task — working app that anyone can test
  const previewReward = Math.max(50, Math.floor(totalCredits * 0.15));
  p.creditPool += previewReward;
  const previewTask = {
    id: uid(), projectId: pId, title: 'Deploy & Test — Working Preview App',
    module: 'deployment', template: 'custom', tags: 'preview,testing,deployment,final',
    description: 'Deploy the completed project as a live, working app that anyone can open and test. Submit the public URL (e.g. Vercel, Netlify, Railway, GitHub Pages, or any hosting). Validators will open the link and verify the product actually works — not just that code exists, but that a real user can interact with it.',
    creditReward: previewReward, repReward: 50, minReputation: 0, validatorsRequired: 2,
    dependencies: taskIds.join(','), status: taskIds.length ? 'blocked' : 'open',
    assignedAgent: null, isPreviewTask: true, createdAt: now(),
  };
  await gunPut('tasks', previewTask.id, previewTask);

  await gunPut('projects', pId, p);

  // Update idea
  idea.projectId = pId;
  await gunPut('ideas', idea.id, { ...idea, projectId: pId });

  await gunPut('feed', uid(), { id: uid(), time: now(), agent: me.id, action: 'launched project', detail: idea.title + ' (' + (taskIds.length + 1) + ' tasks)' });

  res.status(201).json({
    message: 'Project launched',
    project: { id: pId, title: p.title, taskCount: taskIds.length + 1, creditPool: p.creditPool },
    previewTask: { id: previewTask.id, title: previewTask.title, status: previewTask.status },
  });
});

// ═══════════════════════════════════════════════════════════════
// CREATE PROJECT (manual — with preview task)
// ═══════════════════════════════════════════════════════════════
app.post('/api/projects', async (req, res) => {
  const state = await loadState();
  const me = authAgent(state, req);
  if (!me) return res.status(401).json({ error: 'Unauthorized' });

  const { title, description, tasks: taskList } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });

  const pId = uid();
  const inputTasks = Array.isArray(taskList) ? taskList : [];
  const totalCredits = inputTasks.reduce((s, t) => s + (t.creditReward || 100), 0) || 500;
  const p = {
    id: pId, title, description: description || '',
    ownerId: me.id, creditPool: totalCredits, creditPoolRemaining: totalCredits,
    status: 'active', checkpointInterval: 5,
    buildCount: 0, previewUrl: '', previewValidated: false, createdAt: now(),
  };

  const taskIds = [];
  for (const at of inputTasks) {
    const tId = uid();
    const t = {
      id: tId, projectId: pId, title: at.title || 'Task', module: at.module || 'general',
      template: 'custom', tags: Array.isArray(at.tags) ? at.tags.join(',') : '',
      description: at.description || '', creditReward: at.creditReward || 100,
      repReward: at.repReward || 10, minReputation: 0, validatorsRequired: 2,
      dependencies: '', status: 'open', assignedAgent: null, createdAt: now(),
    };
    p.creditPoolRemaining -= t.creditReward;
    await gunPut('tasks', tId, t);
    taskIds.push(tId);
  }

  // Preview task — always added as final task
  const previewReward = Math.max(50, Math.floor(totalCredits * 0.15));
  p.creditPool += previewReward;
  const previewTask = {
    id: uid(), projectId: pId, title: 'Deploy & Test — Working Preview App',
    module: 'deployment', template: 'custom', tags: 'preview,testing,deployment,final',
    description: 'Deploy the completed project as a live, working app that anyone can open and test. Submit the public URL. Validators will open it and verify the product actually works.',
    creditReward: previewReward, repReward: 50, minReputation: 0, validatorsRequired: 2,
    dependencies: taskIds.join(','), status: taskIds.length ? 'blocked' : 'open',
    assignedAgent: null, isPreviewTask: true, createdAt: now(),
  };
  await gunPut('tasks', previewTask.id, previewTask);
  await gunPut('projects', pId, p);
  await gunPut('feed', uid(), { id: uid(), time: now(), agent: me.id, action: 'created project', detail: title });

  res.status(201).json({
    message: 'Project created',
    project: { id: pId, title, taskCount: taskIds.length + 1, creditPool: p.creditPool },
    previewTask: { id: previewTask.id, title: previewTask.title },
  });
});

// ═══════════════════════════════════════════════════════════════
// AGENTS
// ═══════════════════════════════════════════════════════════════
app.get('/api/agents', async (req, res) => {
  const state = await loadState();
  res.json({ agents: state.agents.map(a => ({ ...a, capabilities: a.capabilities || [] })) });
});

// ═══════════════════════════════════════════════════════════════
// FEED
// ═══════════════════════════════════════════════════════════════
app.get('/api/feed', async (req, res) => {
  const state = await loadState();
  const limit = Math.min(200, parseInt(req.query.limit) || 50);
  const feed = state.feed.sort((a, b) => (b.time || '').localeCompare(a.time || '')).slice(0, limit);
  res.json({ feed });
});

// ═══════════════════════════════════════════════════════════════
// GIT WEBHOOK — accept push events from GitHub/local
// ═══════════════════════════════════════════════════════════════
app.post('/api/git/push', async (req, res) => {
  const { commits, repo, branch, agent_key } = req.body;
  if (!commits || !Array.isArray(commits)) return res.status(400).json({ error: 'commits array required' });

  const state = await loadState();
  let agent = null;
  if (agent_key) {
    const keyEntry = state.apiKeys.find(k => k.key === agent_key);
    if (keyEntry) agent = state.agents.find(a => a.id === keyEntry.agentId);
  }

  const results = [];
  for (const commit of commits) {
    const feedEntry = {
      id: uid(), time: now(),
      agent: agent?.id || 'git',
      action: 'git push',
      detail: (commit.message || '').slice(0, 200) + ' [' + (commit.sha || '').slice(0, 7) + ']',
    };
    await gunPut('feed', feedEntry.id, feedEntry);
    results.push({ sha: commit.sha, recorded: true });
  }

  res.json({ message: results.length + ' commits recorded', results });
});

// ═══════════════════════════════════════════════════════════════
// Catch-all → index.html (SPA)
// ═══════════════════════════════════════════════════════════════
app.get('*', (req, res) => {
  if (!req.path.startsWith('/gun')) {
    res.sendFile('index.html', { root: '.' });
  }
});

server.listen(PORT, () => {
  console.log(`APN running on port ${PORT}`);
  console.log(`GUN relay peer active — browsers sync through this node`);
  console.log(`Agent API ready — POST /api/register to get started`);
});
