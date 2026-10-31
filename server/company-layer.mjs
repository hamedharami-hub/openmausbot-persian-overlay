import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync, realpathSync, openSync, closeSync, fstatSync, constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, relative, sep, extname } from "node:path";

const STYLES = new Set(["hierarchy", "flat", "lanes"]);
const FILE_CAP = 2000;
const FILES_MAX = 3;
const PROMPT_MAX_BYTES = 12_000;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const SUMMARY_KEYS = ["decisions", "facts", "tasks", "preferences"];
const BLOCK_KINDS = new Set(["quota", "user_input", "tool_error", "external_uncertain", "other"]);
const PERMISSION_NOTICE = "Project roles do not grant tool permissions, change the sandbox, or remove security approvals. If a bot must ask for permission, the project chief cannot remove that requirement.";
const AUDIT = Symbol("trusted-task-audit");

function validId(value, label = "id") {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value) || RESERVED.has(value)) {
    throw Object.assign(new Error(`invalid ${label}`), { status: 400 });
  }
  return value;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function emptyState() {
  return { schemaVersion: 1, revision: 0, projects: [], threads: {} };
}

function validateState(parsed) {
  if (!object(parsed) || !Array.isArray(parsed.projects) || !object(parsed.threads)) throw new Error("invalid company state");
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) throw new Error("unsupported company schema");
  if (parsed.revision !== undefined && (!Number.isSafeInteger(parsed.revision) || parsed.revision < 0)) throw new Error("invalid company revision");
  if (parsed.audit !== undefined && (!Array.isArray(parsed.audit) || parsed.audit.length > 2000 || parsed.audit.some(event => !object(event) || typeof event.action !== "string" || typeof event.actor !== "string" || typeof event.projectId !== "string" || typeof event.taskId !== "string" || typeof event.at !== "string"))) throw new Error("invalid company audit");
  const ids = new Set();
  for (const [key, value] of Object.entries(parsed.threads)) {
    validId(key, "thread id");
    if (!object(value)) throw new Error("invalid thread state");
    if (value.notes !== undefined && typeof value.notes !== "string") throw new Error("invalid thread notes");
    if (value.summary !== undefined && (!object(value.summary) || Object.entries(value.summary).some(([key, text]) => !SUMMARY_KEYS.includes(key) || typeof text !== "string"))) throw new Error("invalid thread summary");
    for (const key of ["files", "important"]) {
      if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(item => typeof item !== "string"))) throw new Error(`invalid thread ${key}`);
    }
  }
  for (const project of parsed.projects) {
    if (!object(project) || !["members", "memory", "files", "tasks", "chats"].every(key => Array.isArray(project[key]))) throw new Error("invalid project state");
    validId(project.id, "project id");
    if (ids.has(project.id)) throw new Error("duplicate project id");
    ids.add(project.id);
    if (typeof project.name !== "string" || typeof project.goal !== "string" || !STYLES.has(project.style) || typeof project.chiefBotId !== "string") throw new Error("invalid project fields");
    projectMetadata(project);
    for (const member of project.members) {
      if (!object(member) || typeof member.role !== "string" || typeof member.lane !== "string") throw new Error("invalid project member");
      validId(member.botId, "member bot id");
    }
    for (const chat of project.chats) {
      if (!object(chat)) throw new Error("invalid project chat");
      validId(chat.botId, "chat bot id");
      validId(chat.threadId, "chat thread id");
    }
    if (project.files.some(file => typeof file !== "string")) throw new Error("invalid project files");
    for (const memory of project.memory) {
      if (!object(memory) || typeof memory.text !== "string" || !["proposed", "approved", "rejected"].includes(memory.status)) throw new Error("invalid project memory");
      validId(memory.id, "memory id");
    }
    for (const task of project.tasks) {
      if (!object(task) || typeof task.title !== "string" || !["proposed", "open", "done", "rejected"].includes(task.status) || typeof task.percent !== "number" || !Number.isFinite(task.percent) || task.percent < 0 || task.percent > 100) throw new Error("invalid project task");
      validId(task.id, "task id");
      taskDetails(task);
      if (task.verified !== undefined && typeof task.verified !== "boolean") throw new Error("invalid task verification");
      if (task.blockedKind !== undefined && task.blockedKind !== null && !BLOCK_KINDS.has(task.blockedKind)) throw new Error("invalid task blocked kind");
      if (task.verified === true && (task.status !== "done" || !task.result?.trim())) throw new Error("verified task requires a result");
      if (task.executionFailures !== undefined && (!Array.isArray(task.executionFailures) || task.executionFailures.some(item => !object(item) || typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > 1000 || typeof item.at !== "string" || !Number.isFinite(Date.parse(item.at)) || (item.blockedKind !== undefined && item.blockedKind !== null && !BLOCK_KINDS.has(item.blockedKind)) || (item.nextAction !== undefined && item.nextAction !== null && (typeof item.nextAction !== "string" || item.nextAction.length > 500))))) throw new Error("invalid task execution failure history");
      for (const failure of task.executionFailures ?? []) validId(failure.id, "failure id");
    }
  }
  return { ...parsed, schemaVersion: 1, revision: parsed.revision ?? 0 };
}

function taskDetails(input) {
  const details = {};
  for (const key of ["assigneeBotId", "requestId", "threadId"]) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== "") details[key] = validId(input[key], key);
    else if (input[key] === null || input[key] === "") details[key] = null;
  }
  for (const key of ["dueAt", "createdAt", "updatedAt"]) {
    if (input[key] === undefined) continue;
    if (input[key] === null && key === "dueAt") { details[key] = null; continue; }
    if (typeof input[key] !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input[key]) || !Number.isFinite(Date.parse(input[key])) || new Date(input[key]).toISOString().slice(0, 19) !== input[key].slice(0, 19)) throw Object.assign(new Error(`invalid ${key}`), { status: 400 });
    details[key] = new Date(input[key]).toISOString();
  }
  if (input.result !== undefined) {
    if (typeof input.result !== "string" || input.result.length > 4000) throw Object.assign(new Error("result must be text of at most 4000 characters"), { status: 400 });
    details.result = input.result.trim();
  }
  if (input.blockedKind !== undefined) {
    if (input.blockedKind === null || input.blockedKind === "") details.blockedKind = null;
    else if (typeof input.blockedKind === "string" && BLOCK_KINDS.has(input.blockedKind)) details.blockedKind = input.blockedKind;
    else throw Object.assign(new Error("blockedKind is not supported"), { status: 400 });
  }
  for (const key of ["blockedReason", "nextAction"]) {
    if (input[key] !== undefined) {
      if (input[key] === null || input[key] === "") details[key] = null;
      else if (typeof input[key] === "string" && input[key].length <= 500) details[key] = input[key].trim();
      else throw Object.assign(new Error(`${key} must be text of at most 500 characters`), { status: 400 });
    }
  }
  return details;
}

export function projectTaskProgress(project) {
  const accepted = project.tasks.filter(task => task.status === "open" || task.status === "done");
  const verified = accepted.filter(task => task.status === "done" && task.verified === true).length;
  return { total: accepted.length, verified, percent: accepted.length ? Math.round(verified * 100 / accepted.length) : null };
}

export const STALE_TASK_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * Derived, never persisted: an accepted task whose conversation and board record have both been
 * quiet for too long. The status is not changed and nothing is written to disk; the board only
 * marks the task as stalled so a person can look at it.
 *
 * Tasks made before the board kept timestamps carry neither updatedAt nor a thread, so their
 * conversation is found through the project's linked chats for the bot that owns the task.
 */
export function markStaleTasks(state, options = {}) {
  const staleDays = Number.isSafeInteger(options.staleDays) && options.staleDays > 0 ? options.staleDays : STALE_TASK_DAYS;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const activity = typeof options.activity === "function" ? options.activity : () => undefined;
  const threshold = staleDays * DAY_MS;
  const projects = state.projects.map(project => {
    let staleCount = 0;
    const tasks = project.tasks.map(task => {
      if (task.status !== "open") return task;
      const stamp = Date.parse(task.updatedAt ?? task.createdAt ?? "");
      const owner = task.assigneeBotId ?? task.by ?? "";
      const threads = task.threadId
        ? [task.threadId]
        : Array.isArray(project.chats) ? project.chats.filter(chat => chat.botId === owner).map(chat => chat.threadId) : [];
      let last = undefined;
      for (const threadId of threads) {
        const at = activity(threadId, owner);
        if (Number.isFinite(at) && (last === undefined || at > last)) last = at;
      }
      const touched = Number.isFinite(stamp) ? Math.max(stamp, last ?? stamp) : last;
      if (touched === undefined) return task;
      if (now - touched < threshold) return task;
      staleCount += 1;
      return { ...task, stale: true, staleDays: Math.floor((now - touched) / DAY_MS), staleSince: new Date(touched).toISOString() };
    });
    return { ...project, tasks, staleCount };
  });
  return { ...state, projects, staleDays };
}

export function createStore(file) {
  const load = () => {
    try {
      return validateState(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") return emptyState();
      throw Object.assign(new Error("Project data could not be read. It has been preserved; restore or repair it before saving."), { status: 500 });
    }
  };
  const save = (state) => {
    const checked = validateState(state);
    mkdirSync(resolve(file, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(checked), { mode: 0o600 });
    renameSync(tmp, file);
  };
  return { load, save };
}

function clip(text, max = 500) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function id() {
  return randomUUID();
}

function projectMetadata(input) {
  const result = {};
  if (input.section !== undefined) {
    if (typeof input.section !== "string" || input.section.length > 60) throw Object.assign(new Error("section must be text of at most 60 characters"), { status: 400 });
    result.section = input.section.trim();
  }
  if (input.category !== undefined) {
    if (typeof input.category !== "string" || input.category.length > 60) throw Object.assign(new Error("category must be text of at most 60 characters"), { status: 400 });
    result.category = input.category.trim();
  }
  if (input.pinned !== undefined) {
    if (typeof input.pinned !== "boolean") throw Object.assign(new Error("pinned must be true or false"), { status: 400 });
    result.pinned = input.pinned;
  }
  if (input.archivedAt !== undefined) {
    if (input.archivedAt === null) result.archivedAt = null;
    else {
      const value = input.archivedAt;
      const timestamp = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ? Date.parse(value) : NaN;
      if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== value.slice(0, 19)) throw Object.assign(new Error("archivedAt must be an ISO UTC timestamp or null"), { status: 400 });
      result.archivedAt = new Date(timestamp).toISOString();
    }
  }
  return result;
}

export function mutate(store, change, { expectedRevision, [AUDIT]: audit } = {}) {
  const state = store.load();
  if (expectedRevision !== undefined) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw Object.assign(new Error("expectedRevision must be a non-negative integer"), { status: 400 });
    if (expectedRevision !== state.revision) throw Object.assign(new Error("Project data changed. Reload before saving."), { status: 409 });
  }
  const before = JSON.stringify(state);
  const result = change(state);
  if (JSON.stringify(state) === before) return result;
  if (audit) state.audit = [...(state.audit ?? []), { ...audit, taskId: audit.taskId || result.id, at: new Date().toISOString() }].slice(-2000);
  state.revision += 1;
  store.save(state);
  return result;
}

export function addProject(store, input) {
  const name = clip(input.name, 80);
  if (!name) throw Object.assign(new Error("name required"), { status: 400 });
  const style = STYLES.has(input.style) ? input.style : "hierarchy";
  const metadata = projectMetadata(input);
  return mutate(store, (state) => {
    const project = {
      id: id(),
      name,
      goal: clip(input.goal, 400),
      style,
      chiefBotId: typeof input.chiefBotId === "string" ? input.chiefBotId : "",
      category: "",
      pinned: false,
      archivedAt: null,
      ...metadata,
      members: [],
      memory: [],
      files: [],
      tasks: [],
      chats: [],
    };
    if (project.chiefBotId) {
      validId(project.chiefBotId, "chief bot id");
      project.members.push({ botId: project.chiefBotId, role: "chief", lane: "" });
    }
    if (state.projects.length >= 100) throw Object.assign(new Error("project limit reached"), { status: 409 });
    state.projects.push(project);
    return project;
  }, input);
}

function projectOf(state, projectId) {
  validId(projectId, "project id");
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw Object.assign(new Error("project not found"), { status: 404 });
  return project;
}

export function patchProject(store, projectId, patch) {
  const metadata = projectMetadata(patch);
  return mutate(store, (state) => {
    const project = projectOf(state, projectId);
    if (patch.name !== undefined) {
      const name = clip(patch.name, 80);
      if (!name) throw Object.assign(new Error("name required"), { status: 400 });
      project.name = name;
    }
    if (patch.goal !== undefined) project.goal = clip(patch.goal, 400);
    if (patch.style !== undefined) {
      if (!STYLES.has(patch.style)) throw Object.assign(new Error("style must be hierarchy, flat, or lanes"), { status: 400 });
      project.style = patch.style;
    }
    if (typeof patch.chiefBotId === "string") {
      if (patch.chiefBotId && !project.members.some(member => member.botId === patch.chiefBotId)) throw Object.assign(new Error("chief must be a project member"), { status: 409 });
      project.chiefBotId = patch.chiefBotId;
    }
    if (patch.files !== undefined) {
      if (!Array.isArray(patch.files)) throw Object.assign(new Error("files must be a list"), { status: 400 });
      project.files = grantedFiles(patch.files, FILES_MAX);
    }
    Object.assign(project, metadata);
    return project;
  }, patch);
}

export function setMember(store, projectId, member) {
  const botId = validId(member.botId, "bot id");
  return mutate(store, (state) => {
    const project = projectOf(state, projectId);
    const next = { botId, role: clip(member.role, 60) || "member", lane: clip(member.lane, 40) };
    project.members = project.members.filter((item) => item.botId !== botId).concat(next);
    return project;
  }, member);
}

export function removeMember(store, projectId, botId, options = {}) {
  return mutate(store, (state) => {
    const project = projectOf(state, projectId);
    project.members = project.members.filter((item) => item.botId !== botId);
    project.chats = project.chats.filter((item) => item.botId !== botId);
    if (project.chiefBotId === botId) project.chiefBotId = "";
    return project;
  }, options);
}

export function proposeMemory(store, projectId, text, by, options = {}) {
  const note = clip(text, 400);
  if (!note) throw Object.assign(new Error("text required"), { status: 400 });
  return mutate(store, (state) => {
    const project = projectOf(state, projectId);
    const entry = { id: id(), text: note, status: "proposed", by: clip(by, 40) || "bot" };
    if (project.memory.length >= 200) throw Object.assign(new Error("project memory limit reached"), { status: 409 });
    project.memory.push(entry);
    return entry;
  }, options);
}

export function decideMemory(store, projectId, entryId, approve, options = {}) {
  if (typeof approve !== "boolean") throw Object.assign(new Error("approve must be true or false"), { status: 400 });
  return mutate(store, (state) => {
    const project = projectOf(state, projectId);
    const entry = project.memory.find((item) => item.id === entryId);
    if (!entry) throw Object.assign(new Error("memory not found"), { status: 404 });
    entry.status = approve ? "approved" : "rejected";
    return entry;
  }, options);
}

export function proposeTask(store, projectId, input) {
  const title = clip(input.title, 120);
  if (!title) throw Object.assign(new Error("title required"), { status: 400 });
  const details = taskDetails({ assigneeBotId: input.assigneeBotId, threadId: input.threadId, dueAt: input.dueAt, requestId: input.requestId, result: input.result, blockedKind: input.blockedKind, blockedReason: input.blockedReason, nextAction: input.nextAction });
  return mutate(store, (state) => {
    const project = projectOf(state, projectId);
    if (details.assigneeBotId && !project.members.some(member => member.botId === details.assigneeBotId)) throw Object.assign(new Error("assignee must be a project member"), { status: 409 });
    if (details.threadId && !project.chats.some(chat => chat.threadId === details.threadId)) throw Object.assign(new Error("task conversation must be linked to this project"), { status: 409 });
    if (details.requestId) {
      const existing = project.tasks.find(item => item.requestId === details.requestId);
      if (existing) {
        if (existing.title !== title || existing.lane !== clip(input.lane, 40) || existing.by !== (clip(input.by, 40) || "bot") || (existing.assigneeBotId ?? null) !== (details.assigneeBotId ?? null) || (existing.threadId ?? null) !== (details.threadId ?? null) || (existing.dueAt ?? null) !== (details.dueAt ?? null) || (existing.result ?? "") !== (details.result ?? "")) throw Object.assign(new Error("requestId already used for a different task"), { status: 409 });
        return existing;
      }
    }
    const now = new Date().toISOString();
    // Bot-authored work must stay proposed until the explicit decision route is used.
    // Human-created tasks may still be added directly to the board from the UI.
    const openDirectly = input.accept === true && input.by === "user";
    const initialPercent = typeof input.percent === "number" && Number.isFinite(input.percent) && input.percent >= 0 && input.percent <= 100 ? input.percent : 0;
    const task = {
      id: id(),
      title,
      lane: clip(input.lane, 40),
      status: openDirectly ? (initialPercent === 100 ? "done" : "open") : "proposed",
      percent: openDirectly ? initialPercent : 0,
      by: clip(input.by, 40) || "bot",
      ...details,
      createdAt: now,
      updatedAt: now,
    };
    if (project.tasks.length >= 200) throw Object.assign(new Error("project task limit reached"), { status: 409 });
    project.tasks.push(task);
    return task;
  }, input);
}

export function acceptTask(store, projectId, taskId, accept, options = {}) {
  if (typeof accept !== "boolean") throw Object.assign(new Error("accept must be true or false"), { status: 400 });
  return mutate(store, (state) => {
    const project = projectOf(state, projectId);
    const task = project.tasks.find((item) => item.id === taskId);
    if (!task) throw Object.assign(new Error("task not found"), { status: 404 });
    if (accept && (task.status === "open" || task.status === "done")) return task;
    if (!accept && task.status === "rejected") return task;
    if (task.status !== "proposed") throw Object.assign(new Error("Task decision already recorded. Reload before changing it."), { status: 409 });
    task.status = accept ? "open" : "rejected";
    if (!accept && options.reason) task.blockedReason = clip(options.reason, 500);
    task.updatedAt = new Date().toISOString();
    return task;
  }, options);
}

/** A turn-scoped bot may propose work only in the project explicitly linked to that exact bot/thread pair. */
export function proposeTaskFromBot(store, input) {
  const botId = validId(input.botId, "bot id");
  const threadId = validId(input.threadId, "thread id");
  const linked = store.load().projects.filter(project => !project.archivedAt &&
    project.members.some(member => member.botId === botId) &&
    project.chats.some(chat => chat.botId === botId && chat.threadId === threadId));
  if (linked.length !== 1) throw Object.assign(new Error("This conversation is not linked to one active project for this bot."), { status: 403 });
  const project = linked[0];
  const actor = createHash("sha256").update(`bot:${botId}`).digest("hex").slice(0, 24);
  const task = proposeTask(store, project.id, {
    ...input,
    by: botId,
    accept: false,
    percent: 0,
    [AUDIT]: { action: "task_proposed", actor, projectId: project.id },
  });
  return { projectId: project.id, task, revision: store.load().revision };
}

/** Only the project's current chief, using its own linked thread's live turn capability, can decide a bot proposal. */
export function decideTaskAsChief(store, input) {
  const botId = validId(input.botId, "bot id");
  const threadId = validId(input.threadId, "thread id");
  if (typeof input.accept !== "boolean") throw Object.assign(new Error("accept must be true or false"), { status: 400 });
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw Object.assign(new Error("expectedRevision must be a non-negative integer"), { status: 400 });
  const project = projectOf(store.load(), input.projectId);
  if (project.chiefBotId !== botId || !project.members.some(member => member.botId === botId) ||
      !project.chats.some(chat => chat.botId === botId && chat.threadId === threadId)) {
    throw Object.assign(new Error("Only the current project chief in its linked conversation can decide this proposal."), { status: 403 });
  }
  const actor = createHash("sha256").update(`bot-chief:${botId}`).digest("hex").slice(0, 24);
  const options = {
    expectedRevision: input.expectedRevision,
    [AUDIT]: { action: input.accept ? "chief_accept" : "chief_reject", actor, projectId: project.id, taskId: input.taskId },
  };
  const task = acceptTask(store, project.id, input.taskId, input.accept, {
    ...options,
    ...(input.accept === false && typeof input.reason === "string" && input.reason.trim() ? { reason: clip(input.reason, 500) } : {}),
  });
  return { task, revision: store.load().revision };
}

export function updateTask(store, projectId, taskId, patch) {
  const details = taskDetails({ assigneeBotId: patch.assigneeBotId, threadId: patch.threadId, dueAt: patch.dueAt, result: patch.result, blockedKind: patch.blockedKind, blockedReason: patch.blockedReason, nextAction: patch.nextAction });
  return mutate(store, (state) => {
    const project = projectOf(state, projectId);
    const task = project.tasks.find((item) => item.id === taskId);
    if (!task || task.status === "proposed" || task.status === "rejected") {
      throw Object.assign(new Error("task is not on the board"), { status: 409 });
    }
    const before = JSON.stringify(task);
    if (details.assigneeBotId && !project.members.some(member => member.botId === details.assigneeBotId)) throw Object.assign(new Error("assignee must be a project member"), { status: 409 });
    if (details.threadId && !project.chats.some(chat => chat.threadId === details.threadId)) throw Object.assign(new Error("task conversation must be linked to this project"), { status: 409 });
    if (patch.status !== undefined && patch.status !== "open" && patch.status !== "done") throw Object.assign(new Error("status must be open or done"), { status: 400 });
    if (patch.percent !== undefined) {
      if (typeof patch.percent !== "number" || !Number.isFinite(patch.percent) || patch.percent < 0 || patch.percent > 100) throw Object.assign(new Error("percent must be a number from 0 to 100"), { status: 400 });
    }
    if (patch.lane !== undefined) {
      if (typeof patch.lane !== "string") throw Object.assign(new Error("lane must be text"), { status: 400 });
      task.lane = clip(patch.lane, 40);
    }
    if (patch.title !== undefined) {
      const nextTitle = clip(patch.title, 120);
      if (!nextTitle) throw Object.assign(new Error("title required"), { status: 400 });
      task.title = nextTitle;
    }
    if (task.status === "done") {
      if (patch.reopen === true) {
        task.status = "open";
        task.verified = false;
        task.updatedAt = new Date().toISOString();
        if (patch.percent !== undefined) task.percent = patch.percent;
        else if (task.percent === 100) task.percent = 75;
        return task;
      }
      const mayRecordResult = task.verified !== true && details.result !== undefined && Object.keys(details).every(key => key === "result");
      const retry = (patch.status === undefined || patch.status === "done") && (patch.percent === undefined || patch.percent === 100) && (mayRecordResult || Object.entries(details).every(([key, value]) => task[key] === value));
      if (!retry) throw Object.assign(new Error("completed tasks cannot be reopened or changed"), { status: 409 });
      if (mayRecordResult && task.result !== details.result) task.result = details.result;
      if (JSON.stringify(task) !== before) task.updatedAt = new Date().toISOString();
      return task;
    }
    Object.assign(task, details);
    if (patch.percent !== undefined) task.percent = patch.percent;
    if (patch.status === "open" || patch.status === "done") task.status = patch.status;
    if (patch.status === "done") task.percent = 100;
    if (JSON.stringify(task) !== before) task.updatedAt = new Date().toISOString();
    return task;
  }, patch);
}

export function verifyTask(store, projectId, taskId, options = {}) {
  return mutate(store, state => {
    const task = projectOf(state, projectId).tasks.find(item => item.id === taskId);
    if (!task) throw Object.assign(new Error("task not found"), { status: 404 });
    if (task.status !== "done" || !task.result?.trim()) throw Object.assign(new Error("completed task and result are required before verification"), { status: 409 });
    if (task.verified === true) return task;
    task.verified = true;
    task.updatedAt = new Date().toISOString();
    return task;
  }, options);
}

export function recordTaskFailure(store, projectId, taskId, input) {
  const failureId = validId(input.failureId, "failure id");
  const reason = clip(input.reason, 1000);
  if (!reason) throw Object.assign(new Error("failure reason required"), { status: 400 });
  const nextAction = input.nextAction == null ? "" : clip(input.nextAction, 500);
  const blockedKind = taskDetails({ blockedKind: input.blockedKind ?? "other" }).blockedKind;
  const project = projectOf(store.load(), projectId);
  const existingTask = project.tasks.find(item => item.id === taskId);
  if (!existingTask || existingTask.status !== "open") throw Object.assign(new Error("only an open task can record an execution failure"), { status: 409 });
  const existing = (existingTask.executionFailures ?? []).find(item => item.id === failureId);
  if (existing) {
    if (existing.reason !== reason || (existing.nextAction ?? "") !== nextAction || (existing.blockedKind ?? "other") !== blockedKind) throw Object.assign(new Error("failureId already used for different failure details"), { status: 409 });
    return existing;
  }
  return mutate(store, state => {
    const task = projectOf(state, projectId).tasks.find(item => item.id === taskId);
    if (!task || task.status !== "open") throw Object.assign(new Error("only an open task can record an execution failure"), { status: 409 });
    const duplicate = (task.executionFailures ?? []).find(item => item.id === failureId);
    if (duplicate) {
      if (duplicate.reason !== reason || (duplicate.nextAction ?? "") !== nextAction || (duplicate.blockedKind ?? "other") !== blockedKind) throw Object.assign(new Error("failureId already used for different failure details"), { status: 409 });
      return duplicate;
    }
    const failure = { id: failureId, at: new Date().toISOString(), reason, blockedKind, nextAction: nextAction || null };
    task.executionFailures = [...(task.executionFailures ?? []), failure];
    task.blockedReason = reason;
    task.blockedKind = blockedKind;
    task.nextAction = nextAction || null;
    task.updatedAt = failure.at;
    return failure;
  }, input);
}

export function linkChat(store, projectId, botId, threadId, options = {}) {
  validId(botId, "bot id");
  validId(threadId, "thread id");
  return mutate(store, (state) => {
    const project = projectOf(state, projectId);
    if (!project.members.some((item) => item.botId === botId)) {
      throw Object.assign(new Error("bot is not a member"), { status: 409 });
    }
    const elsewhere = state.projects.filter(other => other.id !== project.id && other.chats.some(chat => chat.threadId === threadId));
    if (elsewhere.length && options.move !== true) throw Object.assign(new Error("Conversation belongs to another project. Confirm an explicit move."), { status: 409 });
    for (const other of elsewhere) other.chats = other.chats.filter(item => item.threadId !== threadId);
    if (!project.chats.some(chat => chat.botId === botId && chat.threadId === threadId)) project.chats.push({ botId, threadId });
    return project;
  }, options);
}

export function saveThread(store, threadId, patch) {
  validId(threadId, "thread id");
  return mutate(store, (state) => {
    const current = state.threads[threadId] ?? { notes: "", files: [], summary: {}, important: [] };
    if (patch.notes !== undefined) current.notes = clip(patch.notes, 800);
    if (patch.files !== undefined) {
      if (!Array.isArray(patch.files)) throw Object.assign(new Error("files must be a list"), { status: 400 });
      current.files = grantedFiles(patch.files, FILES_MAX);
    }
    if (patch.summary !== undefined) {
      if (patch.summary === null) current.summary = {};
      else {
        if (!object(patch.summary) || Object.keys(patch.summary).some(key => !SUMMARY_KEYS.includes(key))) throw Object.assign(new Error("summary must contain only decisions, facts, tasks, and preferences"), { status: 400 });
        current.summary = { ...current.summary };
        for (const [key, value] of Object.entries(patch.summary)) {
          if (value !== null && typeof value !== "string") throw Object.assign(new Error("summary fields must be text or null to clear"), { status: 400 });
          current.summary[key] = value === null ? "" : clip(value, 300);
        }
      }
    }
    if (patch.important !== undefined) {
      if (!Array.isArray(patch.important) || patch.important.length > 20) throw Object.assign(new Error("important must be a list of at most 20 message ids"), { status: 400 });
      current.important = [...new Set(patch.important.map(value => validId(value, "message id")))];
    }
    state.threads[threadId] = current;
    return current;
  }, patch);
}

function permittedPath(path) {
  if (typeof path !== "string" || !path || path.length > 4096 || path.includes("\0")) return null;
  const home = realpathSync(homedir());
  const full = realpathSync(resolve(path));
  for (const candidate of [resolve(path), full]) {
    const local = relative(home, candidate);
    if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) return null;
    if (local.split(/[\\/]/).some(part => part.startsWith(".") || /credential|secret|token|^auth(?:\.|$)|^id_(rsa|ed25519)/i.test(part))) return null;
  }
  return full;
}

export function safeFile(path) {
  try {
    const full = permittedPath(path);
    if (!full) return "";
    const info = statSync(full);
    if (!info.isFile() || info.size > 20_000_000) return "";
    const type = extname(full).toLowerCase();
    if ([".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp"].includes(type)) return `[File reference only: ${type}. Contents have not been loaded; use an authorized document/image tool before describing them.]`;
    if (![".txt", ".md", ".csv"].includes(type) || info.size > 200_000) return "";
    const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > 200_000) return "";
      if (process.platform === "linux" && !permittedPath(realpathSync(`/proc/self/fd/${fd}`))) return "";
      const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd));
      return text.length > FILE_CAP ? text.slice(0, FILE_CAP) + "\n[Excerpt shortened; the full document has not been loaded.]" : text;
    } finally { closeSync(fd); }
  } catch {
    return "";
  }
}

function grantedFiles(values, maximum) {
  const paths = [...new Set(values.map(value => String(value)))].filter(Boolean);
  if (paths.length > maximum) throw Object.assign(new Error(`at most ${maximum} files can be granted`), { status: 400 });
  return paths.map(path => {
    if (!safeFile(path)) throw Object.assign(new Error("File unavailable or unsupported. Use a non-private document inside the home folder."), { status: 400 });
    return realpathSync(resolve(path));
  });
}

function rights(project, botId) {
  const chief = project.chiefBotId === botId;
  const preference = project.style === "flat"
    ? "Coordination style: flat. Members may propose peer work inside this project; the chief summarizes. Actual handoffs still require the native coordination route and its permissions. Outside this project, ask the user before contacting another bot."
    : project.style === "lanes"
    ? `Coordination style: lanes. Your assigned lane is (${project.members.find((item) => item.botId === botId)?.lane || "unset"}); work outside it should be proposed to the chief. The chief may propose moving work between lanes. Actual handoffs still require the native coordination route and its permissions. Outside this project, ask the user.`
    : chief
    ? "Coordination style: hierarchy. You are the project chief and organize proposed work. A project role does not itself send assignments or authorize a handoff; use the native coordination route and report its actual result. Outside this project, ask the user."
    : "Coordination style: hierarchy. The project chief organizes work. Do not claim that another bot was assigned unless the native coordination route accepts the handoff. Outside this project, ask the user before contacting another bot.";
  return `${PERMISSION_NOTICE} ${preference}`;
}

export function companyLayerPrompt(store, botId, threadId, sectionHint = "") {
  const state = store.load();
  const thread = threadId ? state.threads[threadId] : undefined;
  const cleanSection = typeof sectionHint === "string" ? sectionHint.trim() : "";
  const explicitlyLinked = threadId ? state.projects.find(item => item.members.some(member => member.botId === botId) && item.chats.some(chat => chat.threadId === threadId && chat.botId === botId)) : undefined;
  const sectionMatched = !explicitlyLinked && cleanSection
    ? state.projects.find(item => !item.archivedAt && ((item.section || "").trim() === cleanSection || (!item.section && item.name.trim() === cleanSection)) && (item.members.some(member => member.botId === botId) || item.chiefBotId === botId))
    : undefined;
  const focused = explicitlyLinked ?? sectionMatched;
  const memberships = state.projects.filter((item) => item.members.some((member) => member.botId === botId));
  const parts = [];
  const background = [];
  if (focused) {
    const member = focused.members.find((item) => item.botId === botId);
    const approved = focused.memory.filter((item) => item.status === "approved").map((item) => item.text);
    const openTasks = focused.tasks.filter((item) => item.status === "open");
    const doneTasks = focused.tasks.filter((item) => item.status === "done");
    const board = [...openTasks.slice(0, 20), ...doneTasks.slice(-10)];
    parts.push(`Project focus: ${focused.name}. Goal: ${focused.goal || "unset"}. Your role: ${member?.role || (focused.chiefBotId === botId ? "chief" : "member")}.`);
    parts.push(rights(focused, botId));
    parts.push("Use these project notes for this linked conversation. This layer adds context; it does not isolate or disable the bot's existing personal memory or tools. Do not claim that it does. Never copy another bot's private memory here.");
    if (explicitlyLinked) {
      parts.push(`This conversation is linked to project id ${focused.id} at revision ${state.revision}. You may propose a task with propose_project_task; it remains pending until the project chief or person accepts it and does not start or hand off work.`);
      if (focused.chiefBotId === botId) {
        const proposals = focused.tasks.filter((task) => task.status === "proposed").slice(0, 20);
        parts.push(`As this project's current chief, you may accept or reject these bot task proposals with decide_project_task. Acceptance adds a task to the project board only; it does not assign or execute work. Recheck that the proposal serves the person's goal. Pending proposals: ${proposals.length ? proposals.map((task) => `${task.title} [task id: ${task.id}; by: ${task.by}]`).join("; ") : "none"}.`);
      }
    }
    if (board.length) {
      const omitted = openTasks.length + doneTasks.length - board.length;
      const rows = board.map((task) => {
        const result = task.result?.trim()
          ? `; ${task.verified === true ? "verified result" : "recorded, unverified result"}: ${clip(task.result, 160)}`
          : "";
        const blocked = task.blockedReason ? `; blocked: ${clip(task.blockedReason, 100)}` : "";
        const next = task.nextAction ? `; next: ${clip(task.nextAction, 100)}` : "";
        return `${clip(task.title, 100)}${task.lane ? ` [${task.lane}]` : ""} ${task.percent}% ${task.status}${result}${blocked}${next}`;
      });
      parts.push(`Project task summary (up to 20 open and 10 most recently completed; full records stay saved${omitted ? `; ${omitted} more not included to limit context` : ""}): ${rows.join("; ")}`);
    }
    if (approved.length) background.push(`Approved project memory: ${approved.join(" | ")}`);
    const files = focused.files.slice(0, FILES_MAX).map((path) => ({ path, text: safeFile(path) })).filter((item) => item.text);
    if (files.length) background.push(files.map((item) => `Granted file ${item.path}:\n${item.text}`).join("\n"));
  } else if (memberships.length) {
    parts.push(`This thread is outside your projects. Do not use their files or project memory here. Outside a project, ask the user before directing another bot. ${PERMISSION_NOTICE}`);
  }
  const currentThread = [];
  if (thread?.notes) currentThread.push(`This chat's own notes: ${thread.notes}`);
  if (thread?.summary) {
    const rows = Object.entries(thread.summary).filter(([, value]) => value);
    if (rows.length) currentThread.push(`Chat summary: ${rows.map(([key, value]) => `${key}: ${value}`).join(" | ")}`);
  }
  if (thread?.important?.length) currentThread.push(`Important message ids: ${thread.important.join(", ")}`);
  const threadFiles = (thread?.files ?? []).slice(0, FILES_MAX).map((path) => ({ path, text: safeFile(path) })).filter((item) => item.text);
  if (threadFiles.length) background.unshift(threadFiles.map((item) => `Chat file ${item.path}:\n${item.text}`).join("\n"));
  const boardIndex = parts.findIndex(part => part.startsWith("Board:"));
  if (boardIndex >= 0) background.unshift(parts.splice(boardIndex, 1)[0]);
  const text = [...parts, ...currentThread, ...background].join("\n");
  const bytes = Buffer.from(text);
  if (bytes.length <= PROMPT_MAX_BYTES) return text;
  return new TextDecoder().decode(bytes.subarray(0, PROMPT_MAX_BYTES - 100), { stream: true }) + "\n[Project context shortened; full notes remain saved in the project.]";
}

export function syncWithDepartments(store, native) {
  if (!native) return store.load();
  const sections = Array.isArray(native.sections) ? native.sections.map(s => String(s ?? "").trim()).filter(Boolean) : [];
  const bots = Array.isArray(native.bots) ? native.bots.filter(b => b && !b.hidden) : [];
  const groups = Array.isArray(native.groups) ? native.groups.filter(g => g && !g.dm) : [];
  if (!sections.length && !bots.some(b => b.section) && !groups.some(g => g.section)) return store.load();
  const allSections = [...new Set([...sections, ...bots.map(b => String(b.section ?? "").trim()).filter(Boolean), ...groups.map(g => String(g.section ?? "").trim()).filter(Boolean)])];
  mutate(store, (state) => {
    for (const sec of allSections) {
      let project = state.projects.find(p => (p.section || "").trim() === sec)
        ?? state.projects.find(p => !p.section && p.name.trim().toLowerCase() === sec.toLowerCase());
      const secBots = bots.filter(b => String(b.section ?? "").trim() === sec);
      const secChief = secBots.find(b => b.chiefOfStaff);
      if (!project) {
        if (state.projects.length >= 100) continue;
        project = {
          id: id(),
          name: clip(sec, 80),
          section: sec,
          goal: "",
          style: "hierarchy",
          chiefBotId: secChief ? secChief.id : "",
          category: sec.includes("/") ? clip(sec.split("/")[0].trim(), 60) : "Department",
          pinned: false,
          archivedAt: null,
          members: [],
          memory: [],
          files: [],
          tasks: [],
          chats: [],
        };
        state.projects.push(project);
      } else if (!project.section) {
        project.section = sec;
      }
      if (secChief && !project.chiefBotId) {
        project.chiefBotId = secChief.id;
      }
      for (const b of secBots) {
        if (!project.members.some(m => m.botId === b.id)) {
          project.members.push({
            botId: b.id,
            role: clip(b.title || (b.chiefOfStaff ? "chief" : "member"), 60),
            lane: sec.includes("/") ? clip(sec.split("/").slice(1).join("/").trim(), 40) : "",
          });
        }
        const bThread = typeof b.threadId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(b.threadId) ? b.threadId : "";
        if (bThread && !project.chats.some(c => c.botId === b.id && c.threadId === bThread)) {
          project.chats.push({ botId: b.id, threadId: bThread });
        }
      }
      const secGroups = groups.filter(g => String(g.section ?? "").trim() === sec);
      for (const g of secGroups) {
        const gThread = typeof g.threadId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(g.threadId) ? g.threadId : "";
        const memberIds = Array.isArray(g.memberIds) ? g.memberIds : [];
        for (const mId of memberIds) {
          if (!bots.some(b => b.id === mId)) continue;
          if (!project.members.some(m => m.botId === mId)) {
            const guestBot = bots.find(b => b.id === mId);
            project.members.push({
              botId: mId,
              role: clip(guestBot?.title || "member", 60),
              lane: clip(g.name || "", 40),
            });
          }
          if (gThread && !project.chats.some(c => c.botId === mId && c.threadId === gThread)) {
            project.chats.push({ botId: mId, threadId: gThread });
          }
        }
      }
    }
  });
  return store.load();
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 100_000) reject(Object.assign(new Error("body too large"), { status: 413 }));
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolvePromise({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!object(value)) throw new Error("expected object");
        resolvePromise(value);
      }
      catch { reject(Object.assign(new Error("invalid json"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

export function companyBots(botsFile, nativeBots) {
  if (Array.isArray(nativeBots) && nativeBots.length) {
    return nativeBots.filter(bot => bot && !bot.hidden && bot.id).map(bot => ({
      id: bot.id,
      name: bot.name || bot.id,
      section: bot.section || "",
      chiefOfStaff: Boolean(bot.chiefOfStaff),
      title: bot.title || "",
    }));
  }
  try {
    const parsed = JSON.parse(readFileSync(botsFile, "utf8"));
    const list = Array.isArray(parsed) ? parsed : [];
    return list.map((bot) => ({ id: bot.id, name: bot.name || bot.id, section: bot.section || "", chiefOfStaff: Boolean(bot.chiefOfStaff), title: bot.title || "" })).filter((bot) => bot.id);
  } catch {
    return [];
  }
}

export async function companyHandle(req, res, ctx, store, botsFile) {
  const { method, path } = ctx;
  const send = (status, body, type = "application/json") => {
    res.statusCode = status;
    res.setHeader("content-type", type);
    res.end(type === "application/json" ? JSON.stringify(body) : body);
    return true;
  };
  const auditTask = (body, action, projectId, taskId = "") => {
    const sessionId = ctx.auth?.kind === "session" ? (ctx.auth.session?.userId || ctx.auth.session?.id) : "local-owner";
    const actor = createHash("sha256").update(String(sessionId || "unknown")).digest("hex").slice(0, 24);
    return { ...body, [AUDIT]: { action, actor, projectId, taskId } };
  };
  try {
    if (!(path === "/company" || path === "/api/company" || path.startsWith("/api/company/"))) return false;
    if (!ctx.auth?.scopes?.includes("admin")) return send(403, { error: "Project management requires the workspace owner or an admin." });
    if (method === "GET" && (path === "/company" || path === "/api/company/ui")) {
      const requested = new URL(req.url || path, "http://localhost");
      const destination = new URL("/?view=projects", "http://localhost");
      const project = requested.searchParams.get("project");
      const section = requested.searchParams.get("section");
      if (project) destination.searchParams.set("project", project);
      if (section) destination.searchParams.set("section", section);
      res.statusCode = 302;
      res.setHeader("location", `${destination.pathname}${destination.search}`);
      res.setHeader("cache-control", "no-store");
      res.end();
      return true;
    }
    if (method === "GET" && path === "/api/company") {
      const state = ctx.native ? syncWithDepartments(store, ctx.native) : store.load();
      const marked = markStaleTasks(state, { activity: ctx.threadActivity, now: Date.now(), staleDays: ctx.staleDays });
      return send(200, {
        ...marked,
        projects: marked.projects.map(project => ({ ...project, progress: projectTaskProgress(project) })),
        bots: companyBots(botsFile, ctx.native?.bots),
        sections: Array.isArray(ctx.native?.sections) ? ctx.native.sections : [],
      });
    }
    if (method === "POST" && path === "/api/company/projects") {
      const body = await readBody(req);
      if (!object(body)) return send(400, { error: "a JSON object is required" });
      if (body.chiefBotId && !ctx.botExists?.(body.chiefBotId)) return send(404, { error: "chief bot not found" });
      const created = addProject(store, body);
      if (created.section && ctx.ensureSection) ctx.ensureSection(created.section, created.chiefBotId ? [created.chiefBotId] : []);
      return send(201, created);
    }
    const memory = path.match(/^\/api\/company\/projects\/([^/]+)\/memory\/([^/]+)$/);
    if (memory && method === "POST") {
      const body = await readBody(req);
      if (typeof body.approve !== "boolean") return send(400, { error: "approve must be true or false" });
      return send(200, decideMemory(store, memory[1], memory[2], body.approve, body));
    }
    const memoryNew = path.match(/^\/api\/company\/projects\/([^/]+)\/memory$/);
    if (memoryNew && method === "POST") {
      const body = await readBody(req);
      return send(201, proposeMemory(store, memoryNew[1], body.text, body.by, body));
    }
    const verify = path.match(/^\/api\/company\/projects\/([^/]+)\/tasks\/([^/]+)\/verify$/);
    if (verify && method === "POST") return send(200, verifyTask(store, verify[1], verify[2], auditTask(await readBody(req), "verify", verify[1], verify[2])));
    const failure = path.match(/^\/api\/company\/projects\/([^/]+)\/tasks\/([^/]+)\/failures$/);
    if (failure && method === "POST") return send(201, recordTaskFailure(store, failure[1], failure[2], auditTask(await readBody(req), "execution_failed", failure[1], failure[2])));
    const accept = path.match(/^\/api\/company\/projects\/([^/]+)\/tasks\/([^/]+)\/accept$/);
    if (accept && method === "POST") {
      const body = await readBody(req);
      if (body.accept !== undefined && typeof body.accept !== "boolean") return send(400, { error: "accept must be a boolean" });
      return send(200, acceptTask(store, accept[1], accept[2], body.accept !== false, auditTask(body, body.accept === false ? "reject" : "accept", accept[1], accept[2])));
    }
    const task = path.match(/^\/api\/company\/projects\/([^/]+)\/tasks\/([^/]+)$/);
    if (task && method === "PATCH") return send(200, updateTask(store, task[1], task[2], auditTask(await readBody(req), "update", task[1], task[2])));
    const tasks = path.match(/^\/api\/company\/projects\/([^/]+)\/tasks$/);
    if (tasks && method === "POST") return send(201, proposeTask(store, tasks[1], auditTask(await readBody(req), "create", tasks[1])));
    const members = path.match(/^\/api\/company\/projects\/([^/]+)\/members$/);
    if (members && method === "POST") {
      const body = await readBody(req);
      if (!ctx.botExists?.(body.botId)) return send(404, { error: "bot not found" });
      return send(200, setMember(store, members[1], body));
    }
    const member = path.match(/^\/api\/company\/projects\/([^/]+)\/members\/([^/]+)$/);
    if (member && method === "DELETE") {
      validId(member[2], "bot id");
      return send(200, removeMember(store, member[1], member[2], await readBody(req)));
    }
    const chats = path.match(/^\/api\/company\/projects\/([^/]+)\/chats$/);
    if (chats && method === "POST") {
      const body = await readBody(req);
      if (body.move !== undefined && typeof body.move !== "boolean") return send(400, { error: "move must be true or false" });
      if (!ctx.canLinkThread?.(body.botId, body.threadId)) return send(404, { error: "conversation does not belong to this bot or its group" });
      return send(200, linkChat(store, chats[1], body.botId, body.threadId, body));
    }
    const one = path.match(/^\/api\/company\/projects\/([^/]+)$/);
    if (one && method === "PATCH") return send(200, patchProject(store, one[1], await readBody(req)));
    const thread = path.match(/^\/api\/company\/threads\/([^/]+)$/);
    if (thread && (method === "PUT" || method === "PATCH")) {
      if (!ctx.threadExists?.(thread[1])) return send(404, { error: "conversation not found" });
      const body = await readBody(req);
      if (!object(body)) return send(400, { error: "a JSON object is required" });
      return send(200, saveThread(store, thread[1], body));
    }
    if (path === "/company" || path.startsWith("/api/company")) return send(404, { error: "not found" });
    return false;
  } catch (error) {
    return send(error.status || 500, { error: error.message || "company layer failed" });
  }
}

export function normalizePath(path) {
  return normalize(isAbsolute(path) ? path : join(homedir(), path));
}
