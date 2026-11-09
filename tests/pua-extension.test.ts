import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The extension resolves ~/.pua once at import time, so HOME must move first.
const HOME = mkdtempSync(join(tmpdir(), "pua-home-"));
process.env.HOME = HOME;

const PUA_DIR = join(HOME, ".pua");
const CONFIG = join(PUA_DIR, "config.json");
const COUNTER = join(PUA_DIR, ".failure_count");
const CHECKPOINT = join(PUA_DIR, "checkpoint.json");

// Dynamic import is required: the extension resolves ~/.pua from HOME at module load.
const { default: pua } = await import("../extensions/pua/index.ts");

type Handler = (event?: unknown, ctx?: unknown) => unknown;
const handlers = new Map<string, Handler>();
const piStub = {
  on: (name: string, handler: Handler) => handlers.set(name, handler),
  registerCommand: () => {},
};
pua(piStub as unknown as Parameters<typeof pua>[0]);

function emit(name: string, event?: unknown, ctx?: unknown): unknown {
  return handlers.get(name)?.(event, ctx);
}

function enable(on = true): void {
  mkdirSync(PUA_DIR, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify({ always_on: on }) + "\n", "utf8");
}

function counter(): string {
  return readFileSync(COUNTER, "utf8").trim();
}

function guard(toolName: string, input: unknown) {
  return emit("tool_call", { toolName, input }) as
    | { block?: boolean; reason?: string; additionalContext?: string }
    | undefined;
}

function start(prompt: string, reason = "prompt") {
  return emit("before_agent_start", { systemPrompt: ["base"], prompt, reason }) as
    | { systemPrompt: string[] }
    | undefined;
}

beforeEach(() => {
  rmSync(COUNTER, { force: true });
  rmSync(CHECKPOINT, { force: true });
  enable(true);
  emit("session_start");
});

describe("U1 frustration gate", () => {
  test("a trigger prompt adds the frustration paragraph", () => {
    const result = start("please try harder");
    expect(Array.isArray(result?.systemPrompt)).toBe(true);
    expect(result?.systemPrompt).toHaveLength(2);
    expect(result?.systemPrompt[1]).toContain("PUA_FRUSTRATION_SIGNAL");
  });

  test("an ordinary prompt yields the base block only", () => {
    const result = start("add a print statement");
    expect(result?.systemPrompt).toHaveLength(2);
    expect(result?.systemPrompt[1]).toContain("PUA_PI_CONTEXT");
    expect(result?.systemPrompt[1]).not.toContain("PUA_FRUSTRATION_SIGNAL");
  });

  test("a CJK trigger matches", () => {
    const result = start("又错了");
    expect(result?.systemPrompt[1]).toContain("PUA_FRUSTRATION_SIGNAL");
  });

  test("always_on false suppresses the override", () => {
    enable(false);
    expect(start("try harder")).toBeUndefined();
  });

  test("reason revive suppresses the override", () => {
    expect(start("try harder", "revive")).toBeUndefined();
  });
});

describe("U2 pressure accounting", () => {
  test("two failures increment the counter", () => {
    emit("tool_result", { isError: true });
    emit("tool_result", { isError: true });
    expect(counter()).toBe("2");
  });

  test("a success does not reset the counter", () => {
    emit("tool_result", { isError: true });
    emit("tool_result", { isError: false, toolName: "bash", details: { exitCode: 0 } });
    expect(counter()).toBe("1");
  });

  test("a non-zero bash exit code increments", () => {
    emit("tool_result", { isError: false, toolName: "bash", details: { exitCode: 1 } });
    expect(counter()).toBe("1");
  });

  test("a zero bash exit code does not increment", () => {
    emit("tool_result", { isError: false, toolName: "bash", details: { exitCode: 0 } });
    expect(existsSync(COUNTER)).toBe(false);
  });

  test("always_on false leaves the counter untouched", () => {
    mkdirSync(PUA_DIR, { recursive: true });
    writeFileSync(COUNTER, "7\n", "utf8");
    enable(false);
    emit("tool_result", { isError: true });
    expect(counter()).toBe("7");
  });
});

describe("U3 integrity guard", () => {
  test("editing a CI workflow blocks", () => {
    const result = guard("edit", { path: ".github/workflows/ci.yml" });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("CI");
  });

  test("editing a test file is advisory, not blocking", () => {
    const result = guard("edit", { path: "tests/foo.test.ts" });
    expect(result?.block).toBeUndefined();
    expect(result?.additionalContext).toBeTruthy();
  });

  test("editing ordinary source returns nothing", () => {
    expect(guard("write", { path: "src/index.ts" })).toBeUndefined();
  });

  test("editing under a scoring directory blocks", () => {
    expect(guard("edit", { path: "pkg/scoring/case.ts" })?.block).toBe(true);
  });

  test("a patch payload naming a CI workflow blocks", () => {
    const result = guard("edit", { input: "*** Begin Patch\n*** Update File: .github/workflows/ci.yml\n+run: true\n" });
    expect(result?.block).toBe(true);
  });

  test("a protected path outranks a test path in one call", () => {
    const result = guard("ast_edit", { paths: ["tests/a.ts", ".github/workflows/ci.yml"] });
    expect(result?.block).toBe(true);
  });

  test(".env blocks", () => {
    expect(guard("write", { path: ".env" })?.block).toBe(true);
  });

  test("always_on false disables every scenario", () => {
    enable(false);
    expect(guard("edit", { path: ".github/workflows/ci.yml" })).toBeUndefined();
    expect(guard("edit", { path: "tests/foo.test.ts" })).toBeUndefined();
    expect(guard("write", { path: ".env" })).toBeUndefined();
  });
});

describe("U4 compaction state and stop reminder", () => {
  test("a compact event writes the checkpoint", () => {
    emit("tool_result", { isError: true });
    emit("tool_result", { isError: true });
    emit("tool_result", { isError: true });
    emit("session_before_compact", {});
    const checkpoint = JSON.parse(readFileSync(CHECKPOINT, "utf8"));
    expect(checkpoint.failures).toBe(3);
    expect(checkpoint.level).toBe("L2");
    expect(typeof checkpoint.saved_at).toBe("number");
  });

  test("a compact event writes nothing while disabled", () => {
    enable(false);
    emit("session_before_compact", {});
    expect(existsSync(CHECKPOINT)).toBe(false);
  });

  test("a newer checkpoint restores into the injected block", () => {
    emit("tool_result", { isError: true });
    emit("tool_result", { isError: true });
    emit("tool_result", { isError: true });
    emit("session_before_compact", {});
    rmSync(COUNTER, { force: true });
    emit("session_start");
    expect(start("hello")?.systemPrompt[1]).toContain("Pressure level: L2");
  });

  test("the stop reminder fires once per session", () => {
    const notes: string[] = [];
    const ctx = { ui: { notify: (message: string) => notes.push(message) } };
    emit("session_stop", {}, ctx);
    emit("session_stop", {}, ctx);
    expect(notes).toHaveLength(1);
  });
});
