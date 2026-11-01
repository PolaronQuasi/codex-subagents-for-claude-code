// Persist stop evidence before signalling. A lost final stop reply must not
// erase the identities captured while descendants still belonged to the root.
export function shutdownEvidence(root, outcome = {}, previous = null) {
  const supplied = outcome.identities ?? outcome.tree;
  const rows = Array.isArray(supplied) ? supplied : [];
  const identities = new Map();
  let malformed = outcome.treeUnknown === true || (supplied != null && !Array.isArray(supplied));
  const targets = [...(previous?.shutdownTree ?? []), root, ...rows];
  for (const target of targets) {
    const pid = typeof target === "number" ? target : target?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      malformed = true;
      continue;
    }
    const value = target?.start ?? target?.processStart;
    const start = typeof value === "string" && value ? value : null;
    identities.set(`${pid}/${start ?? ""}`, { pid, start });
  }
  // A numeric tree can establish an exit later, but can never authorize a
  // signal. Prefer the identity supplied for that PID by the same capture.
  for (const target of identities.values())
    if (target.start !== null) identities.delete(`${target.pid}/`);
  const captured = rows.some((target) => (target?.pid ?? target) === root.pid);
  return {
    shutdownIncomplete: true,
    shutdownTree: [...identities.values()],
    shutdownTreeUnknown: malformed || (!captured && previous?.shutdownTreeUnknown !== false),
    shutdownCapturePending: !malformed && !captured && previous?.shutdownCapturePending !== false,
    shutdownRoot: { pid: root.pid, start: root.start ?? root.processStart ?? null },
  };
}

export async function trackedStop(root, stop, checkpoint) {
  let evidence = shutdownEvidence(root);
  await checkpoint(evidence);
  try {
    const result = await stop(async (identities) => {
      evidence = shutdownEvidence(root, { identities }, evidence);
      await checkpoint(evidence);
    });
    evidence = shutdownEvidence(root, result, evidence);
    await checkpoint(evidence);
    return result;
  } catch (error) {
    await checkpoint(evidence);
    throw error;
  }
}
