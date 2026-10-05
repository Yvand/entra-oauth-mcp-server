import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const ownershipTag = "azd-entra-oauth-mcp-test";

const azMock = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AZ_CALLS, JSON.stringify(args) + "\\n");
const mode = process.env.AZ_MODE;
const queryIndex = args.indexOf("--query");
const query = queryIndex < 0 ? "" : args[queryIndex + 1];
const uriIndex = args.indexOf("--uri");
const uri = uriIndex < 0 ? "" : args[uriIndex + 1];
const output = (value) => process.stdout.write(value + "\\n");
const notFound = () => {
  process.stderr.write("Request_ResourceNotFound: Resource does not exist\\n");
  process.exit(1);
};

if (args[0] === "ad" && args[1] === "app" && args[2] === "show") {
  if (mode === "retry" || mode === "app-absent-sp-active") notFound();
  if (query.startsWith("contains(")) output(mode === "unowned" ? "false" : "true");
  else output("api-app-object");
} else if (args[0] === "ad" && args[1] === "sp" && args[2] === "show") {
  if (mode === "retry") notFound();
  if (query.startsWith("contains(")) output(mode === "sp-unowned" ? "false" : "true");
  else output("api-sp-object");
} else if (args[0] === "rest" && args[1] === "--method" && args[2] === "GET") {
  const isApplication = uri.includes("microsoft.graph.application?");
  if (mode === "app-absent-sp-active" && isApplication) output("None");
  else if (mode === "retry") {
    if (query.startsWith("contains(")) output("true");
    else output(isApplication ? "api-app-object" : "api-sp-object");
  } else output("None");
} else {
  output("");
}
`;

const hookRunners = [
  {
    name: "Bash",
    command: "bash",
    args: ["infra/hooks/postdown-purge-entra-apps.sh"],
  },
  ...(spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0
    ? [
        {
          name: "PowerShell",
          command: "pwsh",
          args: ["-NoProfile", "-File", "infra/hooks/postdown-purge-entra-apps.ps1"],
        },
      ]
    : []),
];

function runHook(runner: (typeof hookRunners)[number], mode: string) {
  const tempDir = mkdtempSync(join(tmpdir(), "entra-cleanup-hook-"));
  const azPath = join(tempDir, "az");
  const callsPath = join(tempDir, "calls.jsonl");
  writeFileSync(azPath, azMock);
  chmodSync(azPath, 0o755);

  try {
    const result = spawnSync(runner.command, runner.args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH}`,
        AZ_CALLS: callsPath,
        AZ_MODE: mode,
        CREATE_ENTRA_APP_REGISTRATIONS: "true",
        ENTRA_API_APP_ID: "api-app-id",
        ENTRA_CLIENT_APP_ID: "",
        ENTRA_APP_OWNERSHIP_TAG: ownershipTag,
      },
    });
    return {
      ...result,
      calls: readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe.each(hookRunners)("$name Entra cleanup hook", (runner) => {
  it("purges the owned service principal before its application", () => {
    const result = runHook(runner, "active");
    expect(result.status).toBe(0);

    const calls = result.calls.map((args) => args.join(" "));
    const spDelete = calls.indexOf("ad sp delete --id api-app-id");
    const spPurge = calls.findIndex(
      (call) => call.includes("DELETE") && call.includes("api-sp-object"),
    );
    const appDelete = calls.indexOf("ad app delete --id api-app-id");
    const appPurge = calls.findIndex(
      (call) => call.includes("DELETE") && call.includes("api-app-object"),
    );
    expect(spDelete).toBeGreaterThanOrEqual(0);
    expect(spDelete).toBeLessThan(spPurge);
    expect(spPurge).toBeLessThan(appDelete);
    expect(appDelete).toBeLessThan(appPurge);
  });

  it("retries purging objects already in Deleted items", () => {
    const result = runHook(runner, "retry");
    expect(result.status).toBe(0);
    expect(result.calls.some((args) => args.join(" ") === "ad sp delete --id api-app-id")).toBe(false);
    expect(result.calls.some((args) => args.join(" ") === "ad app delete --id api-app-id")).toBe(false);
    expect(result.calls.some((args) => args.join(" ").includes("api-sp-object"))).toBe(true);
    expect(result.calls.some((args) => args.join(" ").includes("api-app-object"))).toBe(true);
    expect(
      result.calls.some((args) =>
        args.some((arg) =>
          arg.includes("microsoft.graph.application?%24filter=appId%20eq%20%27api-app-id%27"),
        ),
      ),
    ).toBe(true);
    expect(
      result.calls.some((args) =>
        args.some((arg) =>
          arg.includes(
            "microsoft.graph.servicePrincipal?%24filter=appId%20eq%20%27api-app-id%27",
          ),
        ),
      ),
    ).toBe(true);
  });

  it("refuses to delete an application with a different ownership tag", () => {
    const result = runHook(runner, "unowned");
    expect(result.status).toBe(0);
    expect(result.calls.some((args) => args[0] === "ad" && args[1] === "sp")).toBe(false);
    expect(result.calls.some((args) => args[0] === "rest" && args[2] === "DELETE")).toBe(false);
  });

  it("does not purge the application when its service principal is not owned", () => {
    const result = runHook(runner, "sp-unowned");
    expect(result.status).toBe(0);
    expect(
      result.calls.some(
        (args) => args[0] === "ad" && args[1] === "sp" && args[2] === "delete",
      ),
    ).toBe(false);
    expect(
      result.calls.some(
        (args) => args[0] === "ad" && args[1] === "app" && args[2] === "delete",
      ),
    ).toBe(false);
    expect(
      result.calls.some((args) => args[0] === "rest" && args[2] === "DELETE"),
    ).toBe(false);
  });

  it("can finish cleaning an owned service principal if its app is already purged", () => {
    const result = runHook(runner, "app-absent-sp-active");
    expect(result.status).toBe(0);
    expect(result.calls.some((args) => args.join(" ") === "ad sp delete --id api-app-id")).toBe(true);
    expect(result.calls.some((args) => args.join(" ") === "ad app delete --id api-app-id")).toBe(false);
  });
});

it("runs the irreversible cleanup only from postdown", () => {
  const azureYaml = readFileSync(join(repositoryRoot, "azure.yaml"), "utf8");
  expect(azureYaml).toContain("postdown:");
  expect(azureYaml).not.toMatch(/^\s+predown:/m);
});
