import type { BriefConfig } from "../config.ts";
import { type BriefLanguage, isBriefLanguage, systemBriefLanguage } from "./language.ts";

/** `GET` / `PUT /brief/language`. */
export interface BriefLanguageView {
  language: BriefLanguage;
  /** app: set in the app; system: not set yet, this machine's locale. */
  source: "app" | "system";
}

export class BriefSettingsError extends Error {
  readonly code = "invalid_language";

  constructor() {
    super("invalid_language");
  }
}

export interface BriefSettingsOptions {
  brief: BriefConfig | undefined;
  /** Writes `brief` to daemon.json. */
  save: (brief: BriefConfig) => void;
  log: (message: string) => void;
  /** This machine's language, used until the app sets one. */
  system?: () => BriefLanguage;
}

/**
 * The language briefs are written in. The app sets it (设置 → 语音 → 汇报语言, "跟随系统" resolved
 * on the app's side); it takes effect for the next brief, without a restart.
 */
export class BriefSettings {
  #brief: BriefConfig | undefined;
  readonly #options: BriefSettingsOptions;

  constructor(options: BriefSettingsOptions) {
    this.#options = options;
    this.#brief = options.brief;
  }

  /** The language of the next brief. */
  get language(): BriefLanguage {
    return this.view().language;
  }

  view(): BriefLanguageView {
    return this.#brief
      ? { language: this.#brief.language, source: "app" }
      : { language: (this.#options.system ?? systemBriefLanguage)(), source: "system" };
  }

  save(language: unknown): BriefLanguageView {
    if (!isBriefLanguage(language)) throw new BriefSettingsError();
    if (this.#brief?.language !== language) {
      this.#brief = { language };
      this.#options.save(this.#brief);
      this.#options.log(`[brief] language set by the app: ${language}`);
    }
    return this.view();
  }
}
