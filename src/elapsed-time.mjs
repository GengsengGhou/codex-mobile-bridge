export const elapsedNow = () => Number(process.hrtime.bigint() / 1000000n);

export function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export function heartbeatAge(state, { nowWall = Date.now(), nowMono = elapsedNow(), isAlive = processIsAlive } = {}) {
  if (Number.isFinite(state?.heartbeatMonotonicMs) && state.heartbeatMonotonicMs >= 0) {
    const pid = state?.supervisorPid ?? state?.pid;
    if (!isAlive(pid)) return Infinity;
    return nowMono - state.heartbeatMonotonicMs;
  }
  const wallTime = Date.parse(state?.updatedAt);
  return Number.isFinite(wallTime) ? nowWall - wallTime : Infinity;
}
