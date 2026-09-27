const ACTIVE_TURN_STATUSES = new Set(["active", "inprogress", "in_progress", "running", "pending"]);

function statusName(status) {
  if (typeof status === "string") return status.toLowerCase().replace(/[ -]/g, "_");
  return typeof status?.type === "string" ? status.type.toLowerCase().replace(/[ -]/g, "_") : "";
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.abs(value) < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) {
    const numeric = Number(value);
    return Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
  }
  return typeof value === "string" ? Date.parse(value) || 0 : 0;
}

export function buildTurnBlocks(turn) {
  const blocks = [];
  let workItems = [];
  const flushWork = () => {
    if (workItems.length) blocks.push({ type: "work", items: workItems });
    workItems = [];
  };

  for (const item of Array.isArray(turn?.items) ? turn.items : []) {
    if (item?.type === "userMessage") {
      flushWork();
      blocks.push({ type: "user", item });
    } else if (item?.type === "activity") {
      workItems.push(item);
    } else if (item?.type === "agentMessage") {
      const phase = typeof item.phase === "string" ? item.phase.toLowerCase() : "";
      if (phase === "commentary") workItems.push(item);
      else if (phase === "final_answer" || !phase) {
        flushWork();
        blocks.push({ type: "final", item });
      }
    }
  }
  flushWork();
  return blocks;
}

export function formatWorkSummary(turn) {
  const status = statusName(turn?.status);
  if (ACTIVE_TURN_STATUSES.has(status)) return "工作过程 · 进行中";

  if (["failed", "error"].includes(status)) return "工作过程 · 失败";
  if (["interrupted", "cancelled", "canceled"].includes(status)) return "工作过程 · 已中断";
  let duration = turn?.durationMs == null ? NaN : Number(turn.durationMs);
  if (!Number.isFinite(duration) || duration < 0) {
    const started = timestampMs(turn?.startedAt);
    const completed = timestampMs(turn?.completedAt);
    duration = started && completed >= started ? completed - started : NaN;
  }
  if (!Number.isFinite(duration) || duration < 0) return "工作过程 · 已完成";

  const seconds = Math.floor(duration / 1000);
  if (seconds < 60) return `工作过程 · 用时 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `工作过程 · 用时 ${minutes} 分 ${remainder} 秒` : `工作过程 · 用时 ${minutes} 分`;
}

function basename(path) {
  return typeof path === "string" ? path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || "" : "";
}

export function projectGroup(thread) {
  const projectKey = typeof thread?.projectKey === "string" ? thread.projectKey.trim() : "";
  const projectId = typeof thread?.projectId === "string" ? thread.projectId.trim() : "";
  const projectPath = typeof thread?.projectPath === "string" ? thread.projectPath.trim() : "";
  const cwd = typeof thread?.cwd === "string" ? thread.cwd.trim() : "";
  const key = projectKey || (projectId ? `project:${projectId}` : projectPath || "unassigned");
  const label = key === "unassigned" ? "其他会话" : (typeof thread?.projectName === "string" && thread.projectName.trim()) || basename(projectPath || cwd) || "其他会话";
  return { key, label };
}

export function mergeReadThread(thread, threads) {
  const listed = Array.isArray(threads) ? threads.find(item => item.id === thread?.id) : null;
  if (!listed) return thread;
  return {
    ...listed,
    ...thread,
    projectKey: thread.projectKey || listed.projectKey,
    projectName: thread.projectName || listed.projectName,
    projectId: thread.projectId || listed.projectId,
    projectPath: thread.projectPath || listed.projectPath,
    cwd: thread.cwd || listed.cwd,
    pinned: typeof thread.pinned === "boolean" ? thread.pinned : listed.pinned,
    pinnedIndex: thread.pinnedIndex ?? listed.pinnedIndex,
  };
}
