import { homedir } from "node:os";
import { join } from "node:path";

// Dependency-free on purpose: the Stop hook imports this on every agent turn, and must keep working
// even when the checkout's node_modules is missing (YOUT-244).

/** Where the daemon keeps its config, session records and log (override with OUTBRIEF_HOME). */
export function outbriefHome(): string {
  return process.env.OUTBRIEF_HOME?.trim() || join(homedir(), ".outbrief");
}

export const DEFAULT_LOCAL_PORT = 8790;
