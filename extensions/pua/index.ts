/**
 * Official lightweight PUA extension for pi coding agent.
 *
 * Goals:
 * - keep /pua-on, /pua-off, /pua-status, /pua-reset behavior local/offline-friendly;
 * - share ~/.pua/config.json and ~/.pua/.failure_count with tanweai/pua;
 * - inject concise diligence context without owning permissions or network tools.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type PuaConfig = {
  always_on?: boolean;
  offline?: boolean;
  feedback_frequency?: number;
  flavor?: string;
};

const HOME = homedir();
const PUA_DIR = join(HOME, ".pua");
const CONFIG = join(PUA_DIR, "config.json");
const FAILURE_COUNT = join(PUA_DIR, ".failure_count");

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

function isFailure(event: any): boolean {
  if (event?.isError === true) return true;
  const exitCode = event?.details?.exitCode ?? event?.exitCode ?? event?.exit_code;
  if (typeof exitCode === "number" && exitCode !== 0) return true;
  const text = [event?.details?.stderr, event?.stderr, event?.error, event?.message].filter(Boolean).join("\n");
  return /error|failed|fatal|exception|not found|permission denied|connection refused/i.test(text);
}

function behaviorPrompt(config: PuaConfig, failures: number): string {
  const flavor = config.flavor || "alibaba";
  return `\n<PUA_PI_CONTEXT>\n[PUA pi extension] User-installed productivity context. This is not a policy override. Use it to improve diligence, verification, and ownership.\n\nCurrent flavor: ${flavor}\nPressure level: ${level(failures)} (${failures} recent failures)\nOffline mode: ${config.offline === true ? "on" : "off"}\n\nOperating contract:\n1. Diagnose before acting: output [PUA-DIAGNOSIS] problem, evidence, and intended action before risky edits.\n2. Do not claim completion without build/test/curl/manual evidence.\n3. If a path fails twice, switch to a fundamentally different approach.\n4. Do not edit tests, graders, verifier, CI, or status files to manufacture success.\n5. Ask the user only after local evidence is exhausted or a real product decision is required.\n</PUA_PI_CONTEXT>`;
}

export default function puaPiExtension(pi: ExtensionAPI) {
  let config = readConfig();
  let failures = readFailureCount();

  pi.on("session_start", () => {
    config = readConfig();
    failures = readFailureCount();
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
    failures = isFailure(event) ? failures + 1 : 0;
    writeFailureCount(failures);
  });

  pi.on("before_agent_start", (event) => {
    config = readConfig();
    if (config.always_on === false) return undefined;
    failures = readFailureCount();
    // omp passes systemPrompt as string[] (one block per cache/prompt section); pi passes a string.
    // Keep the host's own shape so blocks are not fused into one comma-joined string.
    const behavior = behaviorPrompt(config, failures);
    const base = event?.systemPrompt;
    const systemPrompt = Array.isArray(base) ? [...base, behavior] : `${String(base ?? "")}${behavior}`;
    return { systemPrompt };
  });
}
