// In-process pub/sub that powers live updates over Server-Sent Events.
// One server instance is enough for this stage; to run several instances,
// swap this for Postgres LISTEN/NOTIFY or Redis without changing callers.

export type WorkspaceEvent = { type: "change"; by?: string };
type Listener = (ev: WorkspaceEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function publish(workspaceId: string, ev: WorkspaceEvent) {
  for (const fn of listeners.get(workspaceId) ?? []) {
    try { fn(ev); } catch { /* a broken stream must not affect others */ }
  }
}

export function subscribe(workspaceId: string, fn: Listener) {
  let set = listeners.get(workspaceId);
  if (!set) listeners.set(workspaceId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) listeners.delete(workspaceId);
  };
}
