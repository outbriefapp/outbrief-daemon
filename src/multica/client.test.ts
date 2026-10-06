import { describe, expect, it } from "vitest";
import { MulticaApiError, MulticaClient } from "./client.ts";

const ISSUE = {
  id: "i1",
  identifier: "YOUT-1",
  title: "t",
  priority: "high",
  project_id: null,
  updated_at: "2026-09-29T00:00:00Z",
};

/** A fetch that answers with `steps` in turn: an Error is thrown, a number is that HTTP status. */
function scripted(steps: (Error | number)[]) {
  const calls: string[] = [];
  const fetchImpl = (async (_url: URL, init?: RequestInit) => {
    calls.push(init?.method ?? "GET");
    const step = steps.shift();
    if (step instanceof Error) throw step;
    const status = step ?? 200;
    return new Response(status === 200 ? JSON.stringify(ISSUE) : "busy", { status });
  }) as unknown as typeof fetch;
  const waits: number[] = [];
  const client = new MulticaClient(
    { apiUrl: "https://api.multica.test", token: "mul_x", workspaceId: "ws" },
    fetchImpl,
    async (ms) => {
      waits.push(ms);
    },
  );
  return { client, calls, waits };
}

const dropped = () => new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });

describe("MulticaClient retries", () => {
  it("retries a read that failed in transit or with 5xx / 429", async () => {
    const { client, calls, waits } = scripted([dropped(), 502, 429, 200]);
    expect(await client.getIssue("i1")).toEqual(ISSUE);
    expect(calls).toHaveLength(4);
    expect(waits).toEqual([500, 1_000, 2_000]);
  });

  it("gives up after 3 retries and says why the connection failed", async () => {
    const { client, calls } = scripted([dropped(), dropped(), dropped(), dropped(), 200]);
    const err = await client.getIssue("i1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MulticaApiError);
    expect((err as MulticaApiError).message).toBe("GET /api/issues/i1: fetch failed (ECONNRESET)");
    expect(calls).toHaveLength(4);
  });

  it("does not retry a 404 or a write", async () => {
    const missing = scripted([404]);
    await expect(missing.client.getIssue("i1")).rejects.toMatchObject({ status: 404 });
    expect(missing.calls).toHaveLength(1);

    const write = scripted([dropped()]);
    await expect(
      write.client.createComment("i1", { content: "好", parentId: "c1" }),
    ).rejects.toBeInstanceOf(MulticaApiError);
    expect(write.calls).toEqual(["POST"]);
  });
});
