import { describe, expect, it } from "vitest";
import { withoutOutbriefHooks } from "./install.ts";

describe("withoutOutbriefHooks", () => {
  it("drops OutBrief hooks from any checkout and the retired outbrief-hook, keeping the rest", () => {
    const hook = (command: string) => ({ type: "command", command });
    expect(
      withoutOutbriefHooks([
        { matcher: "", hooks: [hook("afplay done.mp3")] },
        {
          matcher: "",
          hooks: [hook('"/n/node" "/a/outbrief-daemon/src/cli.ts" hook claude-code')],
        },
        { hooks: [hook('"/n/node" "/b/outbrief-daemon/src/cli.ts" hook codex'), hook("other")] },
        { hooks: [hook("node ~/work/outbrief-hook/src/cli.ts claude-code")] },
      ]),
    ).toEqual([{ matcher: "", hooks: [hook("afplay done.mp3")] }, { hooks: [hook("other")] }]);
  });
});
