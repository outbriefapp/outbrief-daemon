import { execPath } from "node:process";

/**
 * Finds a binary by name, checking PATH. Returns the absolute path or undefined.
 * Uses the current Node executable directory first — launchers may not have a full PATH.
 */
export async function which(name: string): Promise<string | undefined> {
  // Node's own directory (e.g. ~/.nvm/…/bin) is usually where claude / codex live.
  const nodeBinDir = execPath.replace(/\/node$/, "");
  const pathDirs = [nodeBinDir, ...(process.env.PATH?.split(":") ?? [])];
  for (const dir of pathDirs) {
    const candidate = `${dir}/${name}`;
    try {
      const { accessSync, constants } = await import("node:fs");
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not found here
    }
  }
  return undefined;
}

/** Formats an error to a short string. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `run` over `items` with at most `limit` running at once; results keep the order of `items`. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
