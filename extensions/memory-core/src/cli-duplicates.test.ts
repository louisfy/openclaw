import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { declareAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-cli";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import {
  firstWrittenJsonArg,
  spyRuntimeJson,
  spyRuntimeLogs,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMemoryCli } from "./cli.js";

const config = vi.hoisted(() => ({ current: {} as OpenClawConfig }));

// mock-isolation: Supply only synthetic configuration; discovery, reads, chunking and CLI are real.
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  captureRuntimeConfigAsyncReader: () => async () => config.current,
}));

const roots = useAutoCleanupTempDirTracker(afterEach);
const policy = "- Refunds are available within thirty days. Custom-made items are excluded.";
let workspace = "";

beforeEach(async () => {
  const root = roots.make("openclaw-memory-duplicates-");
  workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  config.current = {
    agents: { entries: { main: { workspace } } },
    memory: { search: { provider: "none" } },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

async function write(relative: string, text: string) {
  const target = path.join(workspace, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
}

async function run(...args: string[]) {
  const program = new Command().exitOverride();
  registerMemoryCli(program);
  await program.parseAsync(["memory", "duplicates", ...args], { from: "user" });
}

type Report = {
  agentId: string;
  filesScanned: number;
  duplicateGroupCount: number;
  duplicateOccurrenceCount: number;
  omittedGroups: number;
  groups: Array<{
    occurrences: number;
    omittedLocations: number;
    locations: Array<{ path: string; startLine: number; endLine: number }>;
  }>;
};

describe("memory duplicates CLI", () => {
  it("finds exact repeats across files and within a file, without printing text or changing sources", async () => {
    const originals = {
      "MEMORY.md": `# Policy\n\n${policy}\n\n${policy}\n`,
      "memory/shop.md": `${policy}\r\n`,
      "memory/changed.md": `${policy.replace("thirty", "seven")}\n`,
    };
    for (const [file, text] of Object.entries(originals)) {
      await write(file, text);
    }
    const json = spyRuntimeJson(defaultRuntime);
    await run("--json", "--min-chars", "20");
    expect(firstWrittenJsonArg<Report>(json)).toEqual({
      agentId: "main",
      filesScanned: 3,
      skippedFiles: 0,
      minChars: 20,
      duplicateGroupCount: 1,
      duplicateOccurrenceCount: 3,
      omittedGroups: 0,
      groups: [
        {
          occurrences: 3,
          omittedLocations: 0,
          locations: [
            { path: "MEMORY.md", startLine: 3, endLine: 4 },
            { path: "MEMORY.md", startLine: 5, endLine: 5 },
            { path: "memory/shop.md", startLine: 1, endLine: 1 },
          ],
        },
      ],
    });
    expect(JSON.stringify(firstWrittenJsonArg(json))).not.toContain("Refunds");
    for (const [file, text] of Object.entries(originals)) {
      expect(await fs.readFile(path.join(workspace, file), "utf8")).toBe(text);
    }
  });

  it("uses configured Markdown paths without including unrelated files, sessions or symlink roots", async () => {
    await write("memory/a.md", policy);
    await write("memory/a.txt", policy);
    await write("private.md", policy);
    await write("sessions/session.md", policy);
    await write("docs/policy.md", policy);
    await write("linked/hidden.md", policy);
    await fs.symlink(path.join(workspace, "linked"), path.join(workspace, "memory", "link"), "dir");
    config.current.memory = { search: { extraPaths: ["docs", "memory/link"] } };
    const json = spyRuntimeJson(defaultRuntime);
    await run("--json", "--min-chars", "1");
    expect(firstWrittenJsonArg<Report>(json)).toMatchObject({
      filesScanned: 2,
      duplicateGroupCount: 1,
      groups: [
        {
          locations: [
            { path: "docs/policy.md", startLine: 1, endLine: 1 },
            { path: "memory/a.md", startLine: 1, endLine: 1 },
          ],
        },
      ],
    });
  });

  it("honors agent selection and character thresholds with an explicit empty result", async () => {
    await write("memory/a.md", policy);
    await write("memory/b.md", policy);
    const json = spyRuntimeJson(defaultRuntime);
    await run("--json");
    expect(firstWrittenJsonArg<Report>(json)).toMatchObject({ duplicateGroupCount: 0, groups: [] });
    json.mockClear();
    config.current.agents = {
      entries: {
        main: { workspace },
        ops: { workspace: path.join(workspace, "ops") },
      },
    };
    await run("--json", "--agent", "ops", "--min-chars", "1");
    expect(firstWrittenJsonArg<Report>(json)).toMatchObject({
      agentId: "ops",
      filesScanned: 0,
      groups: [],
    });
  });

  it("reports capped groups and locations without understating the total", async () => {
    for (let index = 0; index < 22; index += 1) {
      await write(
        `memory/${String(index).padStart(2, "0")}.md`,
        `${policy}\n- Separate recurring fact.`,
      );
    }
    const json = spyRuntimeJson(defaultRuntime);
    await run("--json", "--min-chars", "1", "--max-groups", "1");
    expect(firstWrittenJsonArg<Report>(json)).toMatchObject({
      duplicateGroupCount: 2,
      duplicateOccurrenceCount: 44,
      omittedGroups: 1,
      groups: [{ occurrences: 22, omittedLocations: 2 }],
    });
    expect(firstWrittenJsonArg<Report>(json)?.groups[0]?.locations).toHaveLength(20);
  });

  it("prints source locations, but no memory text, in human output", async () => {
    await write("memory/a.md", policy);
    await write("memory/b.md", policy);
    const log = spyRuntimeLogs(defaultRuntime);
    await run("--min-chars", "1");
    const output = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("1 groups in 2 files");
    expect(output).toContain("memory/a.md:1-1");
    expect(output).not.toContain("Refunds");
  });

  it("does not report identical size fragments from the same source line as separate occurrences", async () => {
    await write("memory/long.md", "a".repeat(8_000));
    const json = spyRuntimeJson(defaultRuntime);
    await run("--json");
    expect(firstWrittenJsonArg<Report>(json)).toMatchObject({ duplicateGroupCount: 0, groups: [] });
  });

  it("does not resolve embedding SecretRefs for file-only diagnostics", async () => {
    config.current.memory = {
      search: {
        remote: {
          apiKey: {
            source: "env",
            provider: "default",
            id: "SYNTHETIC_UNSET_EMBEDDING_KEY",
          },
        },
      },
    };
    await write("memory/a.md", policy);
    const json = spyRuntimeJson(defaultRuntime);
    await run("--json");
    expect(firstWrittenJsonArg<Report>(json)).toMatchObject({ filesScanned: 1, groups: [] });
  });

  it.each([false, true])(
    "refuses a configured remote workspace instead of scanning a local copy (stale=%s)",
    async (stale) => {
      if (stale) {
        await write("memory/a.md", policy);
        await write("memory/b.md", policy);
      } else {
        await fs.rm(workspace, { recursive: true });
      }
      config.current.plugins = {
        entries: {
          "file-transfer": {
            config: {
              workspaces: {
                main: { nodeId: "synthetic-node", remoteRoot: "/synthetic/workspace" },
              },
            },
          },
        },
      };
      const json = spyRuntimeJson(defaultRuntime);
      await expect(run("--json")).rejects.toThrow("memory duplicates requires a local workspace");
      expect(json).not.toHaveBeenCalled();
    },
  );

  it("rejects a remote mapping for another agent sharing the selected workspace", async () => {
    config.current.agents = { entries: { main: { workspace }, ops: { workspace } } };
    config.current.plugins = {
      entries: {
        "file-transfer": {
          config: {
            workspaces: { ops: { nodeId: "synthetic-node", remoteRoot: "/synthetic/workspace" } },
          },
        },
      },
    };
    await expect(run("--agent", "main", "--json")).rejects.toThrow(
      "memory duplicates requires a local workspace",
    );
  });

  it("does not block a local workspace because another agent has a different remote workspace", async () => {
    config.current.agents = {
      entries: { main: { workspace }, ops: { workspace: path.join(workspace, "ops") } },
    };
    config.current.plugins = {
      entries: {
        "file-transfer": {
          config: {
            workspaces: { ops: { nodeId: "synthetic-node", remoteRoot: "/synthetic/workspace" } },
          },
        },
      },
    };
    const json = spyRuntimeJson(defaultRuntime);
    await run("--agent", "main", "--json");
    expect(firstWrittenJsonArg<Report>(json)).toMatchObject({
      agentId: "main",
      filesScanned: 0,
      groups: [],
    });
  });

  it("respects a declared but unavailable workspace owner", async () => {
    await write("memory/a.md", policy);
    await write("memory/b.md", policy);
    declareAgentWorkspaceAccess(workspace);
    const json = spyRuntimeJson(defaultRuntime);
    await expect(run("--json")).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_UNAVAILABLE" });
    expect(json).not.toHaveBeenCalled();
  });

  it("reports disabled memory and refuses another plugin's memory slot", async () => {
    const json = spyRuntimeJson(defaultRuntime);
    config.current.memory = { search: { enabled: false } };
    await run("--json");
    expect(firstWrittenJsonArg(json)).toEqual({ agentId: "main", status: "disabled" });
    config.current.plugins = { slots: { memory: "knowledge" } };
    await expect(run("--json")).rejects.toThrow('memory slot selects "knowledge"');
  });

  it.each(["--min-chars", "--max-groups"])(
    "rejects nonpositive %s before scanning",
    async (flag) => {
      const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
      registerMemoryCli(program);
      await expect(
        program.parseAsync(["memory", "duplicates", flag, "0"], { from: "user" }),
      ).rejects.toMatchObject({ code: "commander.invalidArgument" });
    },
  );
});
