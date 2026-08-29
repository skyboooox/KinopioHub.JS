export function pushOutputLine(state, prefix, content) {
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    state.outputTail.push(`${prefix}${line}`);
  }
  if (state.outputTail.length > 50) {
    state.outputTail.splice(0, state.outputTail.length - 50);
  }
}

export async function terminateChildProcess(childProcess) {
  if (!childProcess || childProcess.exitCode !== null || childProcess.killed) {
    return;
  }

  let fallbackTimer;
  const exitPromise = new Promise((resolve) => {
    childProcess.once("exit", () => {
      clearTimeout(fallbackTimer);
      resolve();
    });
  });
  const timeoutPromise = new Promise((resolve) => {
    fallbackTimer = setTimeout(() => resolve("timeout"), 5_000);
    fallbackTimer.unref?.();
  });

  childProcess.kill("SIGTERM");
  const result = await Promise.race([exitPromise, timeoutPromise]);
  if (result === "timeout") {
    childProcess.kill("SIGKILL");
    await exitPromise;
  }
}
