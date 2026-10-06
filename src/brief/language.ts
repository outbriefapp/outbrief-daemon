import { execFileSync } from "node:child_process";

/**
 * The language briefs are written in: what the call speaks and shows. A BCP 47 language-region
 * locale ("zh-CN", "es-MX"), set in the app (设置 → 语音 → 汇报语言), which offers the target languages
 * of youtube-dubbing-extension that have Azure voices (outbrief-app `src/voice/azureVoices.ts`).
 */
export type BriefLanguage = string;

const LANGUAGE_REGION = /^[a-z]{2,3}-[A-Z]{2}$/;

/** Languages whose lengths are counted in characters (字) rather than words. */
const CHARACTER_COUNTED = ["zh", "ja", "ko", "th", "lo", "km", "my"];

const names = new Intl.DisplayNames(["zh"], { type: "language", fallback: "none" });

/** A language-region locale that has a name. */
export function isBriefLanguage(value: unknown): value is BriefLanguage {
  return typeof value === "string" && LANGUAGE_REGION.test(value) && !!names.of(value);
}

/** How the prompt names the language, e.g. "墨西哥西班牙语"; Chinese with its script ("中文（繁体，台湾）"). */
export function briefLanguageName(language: BriefLanguage): string {
  const tag = language.startsWith("zh-")
    ? new Intl.Locale(language).maximize().toString()
    : language;
  return names.of(tag) ?? language;
}

/** Whether lengths in `language` are counted in characters (字) rather than words. */
export function countsCharacters(language: BriefLanguage): boolean {
  return CHARACTER_COUNTED.includes(language.split("-")[0] ?? "");
}

/**
 * macOS's preferred languages (系统设置 → 语言与地区), e.g. ["zh-Hans-CN", "en-US"]. A daemon
 * started by launchd or a shell without LANG would otherwise see only "en-US".
 */
function macLanguages(): string[] {
  if (process.platform !== "darwin") return [];
  try {
    const out = execFileSync("defaults", ["read", "-g", "AppleLanguages"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    return [...out.matchAll(/"?([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)"?\s*,?\s*$/gm)].map(
      (m) => m[1] ?? "",
    );
  } catch {
    return [];
  }
}

/** This machine's languages, most preferred first. */
function machineLocales(): string[] {
  return [
    ...macLanguages(),
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
    Intl.DateTimeFormat().resolvedOptions().locale,
  ].filter((l): l is string => !!l && l !== "C" && l !== "POSIX");
}

/**
 * The first of `locales` (BCP 47 or POSIX, e.g. "zh-Hans-CN", "ja_JP.UTF-8", "pt") as language-region,
 * the region filled in where the language is most spoken ("zh-CN", "ja-JP", "pt-BR"); en-US when
 * none is usable. Until the app sets one, briefs follow this machine's languages.
 */
export function systemBriefLanguage(locales: readonly string[] = machineLocales()): BriefLanguage {
  for (const raw of locales) {
    let locale: Intl.Locale;
    try {
      locale = new Intl.Locale(raw.split(".")[0]?.replace(/_/g, "-") ?? "").maximize();
    } catch {
      continue;
    }
    const candidate = `${locale.language}-${locale.region}`;
    if (isBriefLanguage(candidate)) return candidate;
  }
  return "en-US";
}
