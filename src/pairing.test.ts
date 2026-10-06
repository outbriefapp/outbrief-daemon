import { describe, expect, it } from "vitest";
import { pairingLink, parsePairingInput } from "./pairing.ts";

describe("pairing input", () => {
  const invite = {
    serverUrl: "https://outbrief.example.com:8443",
    code: "042917",
    key: "obk1_Lx4pmWArsLrCqKgNPE7sIYbZh5EQ66DRTMvbmmmmsQY",
  };

  it("round-trips a pairing link with the server address, the code and the key", () => {
    const link = pairingLink(invite);
    expect(link).toMatch(/^outbrief:\/\/pair\?/);
    expect(parsePairingInput(link)).toEqual(invite);
    expect(parsePairingInput(`  ${link}\n`)).toEqual(invite);
  });

  it("takes 6 typed digits, spaces allowed, with no server or key", () => {
    expect(parsePairingInput("042 917")).toEqual({ code: "042917" });
    expect(parsePairingInput("04291")).toBeUndefined();
    expect(parsePairingInput("https://evil.test/?code=042917")).toBeUndefined();
    expect(parsePairingInput("outbrief://pair?code=12&server=https://a.test")).toBeUndefined();
  });
});
