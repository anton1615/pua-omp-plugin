/**
 * Official lightweight PUA extension for pi coding agent.
 *
 * Goals:
 * - keep /pua-on, /pua-off, /pua-status, /pua-reset behavior local/offline-friendly;
 * - share ~/.pua/config.json and ~/.pua/.failure_count with tanweai/pua;
 * - inject concise diligence context without owning permissions or network tools;
 * - mirror the Claude hook policy (frustration trigger, integrity guard) as ported data.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type PuaConfig = {
  always_on?: boolean;
  offline?: boolean;
  feedback_frequency?: number;
  flavor?: string;
};

type Checkpoint = {
  level?: string;
  failures?: number;
  flavor?: string;
  saved_at?: number;
};

// HOME the environment variable is authoritative on POSIX (the Claude hooks use it too);
// os.homedir() is cached per process by some runtimes, which breaks test isolation.
const HOME = process.env.HOME || homedir();
const PUA_DIR = join(HOME, ".pua");
const CONFIG = join(PUA_DIR, "config.json");
const FAILURE_COUNT = join(PUA_DIR, ".failure_count");
const CHECKPOINT = join(PUA_DIR, "checkpoint.json");

// Ported verbatim from tanweai/pua hooks/frustration-trigger.sh (POSIX character
// classes translated: [[:alnum:]_] -> [A-Za-z0-9_]).
const TRIGGER = new RegExp(
  "try harder|stop giving|figure it out|you keep failing|keep failing|still failing|why.*fail|stop spinning|you broke|again\\?\\?\\?|third time|change approach|different approach|retry this|try again|not good enough|quality.*bad|terrible|sloppy|didn.?t (run|test|verify)|didn.?t even run|run the tests|verify your changes|before saying they work|no evidence|where.*evidence|show.*evidence|done without proof|not done|said.*fixed|PUA模式|/pua|(^|[^A-Za-z0-9_])pua([^A-Za-z0-9_]|$)|别偷懒|别摆烂|摆烂|又错了|还不行|怎么搞|降智|原地打转|能不能靠谱|认真点|不行啊|为什么还不行|你怎么又|换个方法|加油|再试试|再来一遍|别放弃|质量太差|不靠谱|重新做|怎么又失败|差不多就行|没做到位|没跑测试|没有测试|没验证|没有验证|证据呢|证据在哪|数据在哪|验收|闭环|自嗨|空口完成|别说完成|打工人提醒|置身钉内|置身钉外|无招|(^|[^A-Za-z])ONE([^A-Za-z]|$)|老板体感|周报|改口径|口径|每日一包|薛定谔的用户|病态敏捷|已读恐怖主义|望舒行动|全景监狱|透明鸟笼|人工个性化|温室数据|做错事|发心|捆柴|手感|油尽灯枯|查岗|泰坦尼克",
  "i",
);

// Ported from hooks/integrity-guard.sh. Only tools that write a file are inspected,
// so the script's secret-READ table is intentionally absent (KTD1).
const TEST_PATH = /(^|\/)(tests?|__tests__|test|spec)(\/|$)|\.(test|spec)\.[A-Za-z0-9]+$/i;

const BLOCK_PATTERNS: Array<[RegExp, string]> = [
  [
    /(^|\/)(evals?|e2e|cypress|playwright)(\/|$)|(^|\/)(playwright|cypress)\.config\./i,
    "Grader gaming risk: tests/evals/E2E assets are scoring-adjacent.",
  ],
  [
    /(^|\/)(score|scoring|grader|verifier)(\.[A-Za-z0-9]+)?$|(^|\/)(scoring|grader|verifier)(\/|$)/i,
    "Grader gaming risk: scoring/verifier assets must not be changed by the executor.",
  ],
  [
    /(^|\/)\.github\/workflows(\/|$)|(^|\/)ci(\/|$)|(^|\/)(buildkite|circleci|jenkins)(\/|$)/i,
    "Environment-modification risk: CI gates are part of the verifier boundary.",
  ],
  [
    /(^|\/)(feature_contracts\.json|claude-progress\.md|progress\.json|status\.json)$/i,
    "Self-report cheating risk: status/progress files need verifier ownership.",
  ],
  [
    /(^|\/)(memory|memories)(\/|$)|(^|\/)(decisions|failures)\.log\.jsonl$|(^|\/)CLAUDE\.md$|(^|\/)\.claude\/(settings|settings\.local)\.json$/i,
    "Persistent-memory risk: long-term memory/status must be append-only or approved.",
  ],
  [
    /(^|\/)\.env(\.|$)|(^|\/)(secrets?|credentials?)(\.|\/|$)/i,
    "Capability-abuse risk: secrets and environment files require human gate.",
  ],
  [
    /(^|\/)(hidden[-_]?tests?|verifier[-_]?private|private[-_]?verifier|hidden[-_]?cases?)(\/|$)/i,
    "Solution contamination risk: hidden tests/verifier-private assets must stay outside the agent workspace.",
  ],
  [
    /(^|\/)(hidden_solution|gold_patch|golden_patch|benchmark_answers?|answer_key|official_solution)(\.|\/|$)/i,
    "Solution contamination risk: hidden solution / benchmark answer artifact detected.",
  ],
];

const WRITE_TOOLS = new Set(["edit", "write", "ast_edit", "apply_patch"]);
const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Move to|Edit File|Delete File): *(.+)$/gm;

function readConfig(): PuaConfig {
  try {
    if (existsSync(CONFIG)) return JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {}
  return {};
}

function writeConfig(patch: PuaConfig): PuaConfig {
  mkdirSync(PUA_DIR, { recursive: true });
  const next = { ...readConfig(), ...patch };
  writeFileSync(CONFIG, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

function readFailureCount(): number {
  try {
    if (existsSync(FAILURE_COUNT)) {
      const n = Number(readFileSync(FAILURE_COUNT, "utf8").trim());
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    }
  } catch {}
  return 0;
}

function writeFailureCount(n: number): void {
  mkdirSync(PUA_DIR, { recursive: true });
  writeFileSync(FAILURE_COUNT, String(Math.max(0, Math.floor(n))) + "\n", "utf8");
}

function level(n: number): string {
  if (n >= 5) return "L4";
  if (n >= 4) return "L3";
  if (n >= 3) return "L2";
  if (n >= 2) return "L1";
  return "L0";
}

type ToolResultLike = { isError?: boolean; details?: { exitCode?: unknown }; exitCode?: unknown; exit_code?: unknown };
type EditEntry = { rename?: unknown };

function exitCodeOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isFailure(event: unknown): boolean {
  // Boundary: the host event is structural, so narrow only the fields the policy reads.
  const result = event as ToolResultLike | undefined;
  if (result?.isError === true) return true;
  const exitCode =
    exitCodeOf(result?.details?.exitCode) ?? exitCodeOf(result?.exitCode) ?? exitCodeOf(result?.exit_code);
  return exitCode !== undefined && exitCode !== 0;
}

// R6: a checkpoint newer than the live counter replaces it for this session.
function restoreCheckpoint(): number | null {
  try {
    if (!existsSync(CHECKPOINT)) return null;
    const checkpoint: Checkpoint = JSON.parse(readFileSync(CHECKPOINT, "utf8"));
    const savedAt = Number(checkpoint?.saved_at) || 0;
    const writtenAt = existsSync(FAILURE_COUNT) ? statSync(FAILURE_COUNT).mtimeMs : 0;
    const count = Number(checkpoint?.failures);
    if (!Number.isFinite(count) || savedAt <= writtenAt) return null;
    return Math.max(0, Math.floor(count));
  } catch {
    return null;
  }
}

function toolPaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of ["path", "file_path"]) {
    const value = record[key];
    if (typeof value === "string") paths.push(value);
  }
  if (Array.isArray(record.paths)) {
    for (const p of record.paths) if (typeof p === "string") paths.push(p);
  }
  if (Array.isArray(record.edits)) {
    for (const edit of record.edits as EditEntry[]) {
      if (typeof edit?.rename === "string") paths.push(edit.rename);
    }
  }
  if (typeof record.input === "string") {
    for (const match of record.input.matchAll(PATCH_PATH)) paths.push(match[1].trim());
  }
  return paths;
}

function behaviorPrompt(config: PuaConfig, failures: number): string {
  const flavor = config.flavor || "alibaba";
  return `\n<PUA_PI_CONTEXT>\n[PUA pi extension] User-installed productivity context. This is not a policy override. Use it to improve diligence, verification, and ownership.\n\nCurrent flavor: ${flavor}\nPressure level: ${level(failures)} (${failures} recent failures)\nOffline mode: ${config.offline === true ? "on" : "off"}\n\nOperating contract:\n1. Diagnose before acting: output [PUA-DIAGNOSIS] problem, evidence, and intended action before risky edits.\n2. Do not claim completion without build/test/curl/manual evidence.\n3. If a path fails twice, switch to a fundamentally different approach.\n4. Do not edit tests, graders, verifier, CI, or status files to manufacture success.\n5. Ask the user only after local evidence is exhausted or a real product decision is required.\n</PUA_PI_CONTEXT>`;
}

function frustrationPrompt(): string {
  return `\n<PUA_FRUSTRATION_SIGNAL>\n[PUA Frustration Signal] The user's prompt signals frustration or a repeated failure. Raise diligence: switch to a materially different approach instead of retuning the same one, and show verification evidence (commands run, relevant output, remaining risk). Do not hide failed checks or replace evidence with confidence; completion stays pending until concrete acceptance evidence supports it.\n</PUA_FRUSTRATION_SIGNAL>`;
}

export default function puaPiExtension(pi: ExtensionAPI) {
  let config = readConfig();
  let failures = readFailureCount();
  let stopNotified = false;

  pi.on("session_start", () => {
    config = readConfig();
    failures = readFailureCount();
    const restored = restoreCheckpoint();
    if (restored !== null) failures = restored;
    stopNotified = false;
  });

  pi.registerCommand("pua-on", {
    description: "Enable PUA always-on mode for pi and shared ~/.pua/config.json.",
    handler: async (_args, ctx) => {
      const patch: PuaConfig = { always_on: true };
      if (readConfig().feedback_frequency === 0) patch.feedback_frequency = 5;
      config = writeConfig(patch);
      ctx?.ui?.notify?.("[PUA ON] pi extension enabled.", "success");
    },
  });

  pi.registerCommand("pua-off", {
    description: "Disable PUA always-on mode and feedback prompts.",
    handler: async (_args, ctx) => {
      config = writeConfig({ always_on: false, feedback_frequency: 0 });
      ctx?.ui?.notify?.("[PUA OFF] pi extension disabled.", "info");
    },
  });

  pi.registerCommand("pua-status", {
    description: "Show PUA pi extension state.",
    handler: async (_args, ctx) => {
      config = readConfig();
      failures = readFailureCount();
      ctx?.ui?.notify?.(`PUA status\n- enabled: ${config.always_on === true}\n- offline: ${config.offline === true}\n- failures: ${failures}\n- level: ${level(failures)}\n- config: ${CONFIG}`, "info");
    },
  });

  pi.registerCommand("pua-reset", {
    description: "Reset shared PUA failure counter.",
    handler: async (_args, ctx) => {
      failures = 0;
      writeFailureCount(0);
      ctx?.ui?.notify?.("[PUA RESET] failure counter reset.", "info");
    },
  });

  pi.on("tool_result", (event) => {
    config = readConfig();
    if (config.always_on === false) return;
    if (!isFailure(event)) return;
    failures = failures + 1;
    writeFailureCount(failures);
  });

  pi.on("tool_call", (event) => {
    config = readConfig();
    if (config.always_on === false) return;
    if (!WRITE_TOOLS.has(String(event?.toolName))) return;
    for (const raw of toolPaths(event?.input)) {
      const path = raw.replace(/\\/g, "/");
      if (TEST_PATH.test(path)) {
        return { additionalContext: `[PUA] Test path edit: ${path}. Keep existing assertions intact; do not weaken a test to manufacture a pass.` };
      }
      for (const [pattern, reason] of BLOCK_PATTERNS) {
        if (pattern.test(path)) return { block: true, reason: `${reason} (${path})` };
      }
    }
    return;
  });

  pi.on("session_before_compact", () => {
    config = readConfig();
    if (config.always_on === false) return;
    const checkpoint: Checkpoint = {
      level: level(failures),
      failures,
      flavor: config.flavor || "alibaba",
      saved_at: Date.now(),
    };
    mkdirSync(PUA_DIR, { recursive: true });
    writeFileSync(CHECKPOINT, JSON.stringify(checkpoint, null, 2) + "\n", "utf8");
  });

  pi.on("session_stop", (_event, ctx) => {
    config = readConfig();
    if (config.always_on === false || stopNotified) return;
    stopNotified = true;
    ctx?.ui?.notify?.(
      "[PUA] Session ending: report verification evidence (commands run, relevant output, remaining risk). No rating recorded.",
      "info",
    );
  });

  pi.on("before_agent_start", (event) => {
    config = readConfig();
    if (config.always_on === false) return undefined;
    if (event?.reason === "revive") return undefined;
    const matched = TRIGGER.test(String(event?.prompt ?? ""));
    const behavior = behaviorPrompt(config, failures) + (matched ? frustrationPrompt() : "");
    // omp passes systemPrompt as string[] (one block per cache/prompt section); pi passes a string.
    // Keep the host's own shape so blocks are not fused into one comma-joined string.
    const base = event?.systemPrompt;
    const systemPrompt = Array.isArray(base) ? [...base, behavior] : `${String(base ?? "")}${behavior}`;
    return { systemPrompt };
  });
}
