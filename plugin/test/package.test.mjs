import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import { buildPackage, packageFiles, versionFromTag } from "../scripts/package.mjs";

const source = new URL("../appPackage/", import.meta.url);
const manifestUrl = new URL("manifest.json", source);

async function fixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), "cowork-plugin-"));
  try {
    await cp(source, directory, { recursive: true });
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    await callback(directory, manifest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function saveManifest(directory, manifest) {
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
}

test("release tag extracts the canonical numeric version", () => {
  for (const version of ["0.0.0", "1.2.3", "10.20.300"]) {
    assert.equal(versionFromTag(`releases/plugin/v${version}`), version);
  }
});

test("malformed and unrelated tags are rejected before packaging", () => {
  for (const tag of [
    "", "v1.2.3", "releases/server/v1.2.3", "releases/plugin/v1.2",
    "releases/plugin/v1.2.3.4", "releases/plugin/v1.2.3-beta",
    "releases/plugin/v1.2.3+build", "releases/plugin/v01.2.3",
    "releases/plugin/v1.02.3", "releases/plugin/v1.2.03",
    "releases/plugin/v-1.2.3", "releases/plugin/v1.2.3\n",
    "releases/plugin/v1.2.3/extra", "releases/plugin/v$(echo unsafe)",
  ]) {
    assert.throws(() => versionFromTag(tag), /Expected a tag/);
  }
});

test("ZIP has only root manifest, icons, and one skill calling both tools", async () => {
  const { bytes, fileName, manifest } = await buildPackage();
  const entries = unzipSync(bytes);
  assert.deepEqual(Object.keys(entries).sort(), packageFiles);
  assert.equal(fileName, `entra-mcp-cowork-plugin-template-${manifest.version}.zip`);
  assert.equal(manifest.agentSkills.length, 1);
  assert.equal(manifest.agentConnectors.length, 1);
  const skill = strFromU8(entries["skills/entra-mcp-demo/SKILL.md"]);
  assert.match(skill, /^name: entra-mcp-demo$/m);
  assert.match(skill, /Call `whoami` with `\{\}`/);
  assert.match(skill, /Call `echo` with/);
  assert.match(skill, /Hello from Microsoft 365 Copilot/);
  assert.match(skill, /1-4000 characters/);
});

test("release version changes the ZIP manifest only and is reproducible", async () => {
  const original = await readFile(manifestUrl);
  const serverUrl = new URL("../../server/package.json", import.meta.url);
  const serverOriginal = await readFile(serverUrl);
  const version = versionFromTag("releases/plugin/v1.2.3");
  const result = await buildPackage({ version });
  const entries = unzipSync(result.bytes);
  const packaged = JSON.parse(strFromU8(entries["manifest.json"]));
  assert.equal(packaged.version, "1.2.3");
  assert.equal(packaged.id, JSON.parse(original).id);
  assert.equal(result.fileName, "entra-mcp-cowork-plugin-template-1.2.3.zip");
  assert.deepEqual(await readFile(manifestUrl), original);
  assert.deepEqual(await readFile(serverUrl), serverOriginal);
  assert.deepEqual((await buildPackage({ version })).bytes, result.bytes);
});

test("invalid explicit versions are rejected", async () => {
  for (const version of ["1.2", "01.2.3", "1.2.3-rc.1", "1.2.3\n"]) {
    await assert.rejects(buildPackage({ version }), /Plugin version/);
  }
});

test("configured packaging refuses the shipped placeholders", async () => {
  await assert.rejects(buildPackage({ configured: true }), /Replace.*placeholders/);
});

test("configured package requires endpoint, OAuth reference, and developer replacements", async () => {
  await fixture(async (directory, manifest) => {
    const remote = manifest.agentConnectors[0].toolSource.remoteMcpServer;
    remote.mcpServerUrl = "https://demo.contoso.com/mcp";
    remote.authorization.referenceId = "demo-token-vault-registration";
    await saveManifest(directory, manifest);
    await assert.rejects(buildPackage({ directory, configured: true }), /placeholders/);
    manifest.developer.name = "Demo Developer";
    manifest.developer.privacyUrl = "https://demo.contoso.com/privacy";
    manifest.developer.termsOfUseUrl = "https://demo.contoso.com/terms";
    await saveManifest(directory, manifest);
    const result = await buildPackage({ directory, configured: true });
    assert.equal(result.fileName, "entra-mcp-cowork-plugin-configured-1.0.0.zip");
    assert.equal(result.manifest.agentConnectors[0].toolSource.remoteMcpServer.mcpServerUrl,
      "https://demo.contoso.com/mcp");
  });
});

test("official schema rejects unknown and malformed manifest fields", async () => {
  for (const mutate of [
    (m) => { m.packageName = "not-allowed"; },
    (m) => { m.id = "not-a-guid"; },
    (m) => { delete m.name; },
    (m) => { m.agentConnectors[0].toolSource.remoteMcpServer.authorization.type = "invalid"; },
  ]) {
    await fixture(async (directory, manifest) => {
      mutate(manifest);
      await saveManifest(directory, manifest);
      await assert.rejects(buildPackage({ directory }), /Invalid manifest/);
    });
  }
});

test("exactly one matching skill and connector are required", async () => {
  for (const mutate of [
    (m) => { m.agentSkills.push({ folder: "./skills/another" }); },
    (m) => { m.agentSkills[0].folder = "../outside"; },
    (m) => { m.agentConnectors.push(structuredClone(m.agentConnectors[0])); },
    (m) => { m.agentConnectors = []; },
  ]) {
    await fixture(async (directory, manifest) => {
      mutate(manifest);
      await saveManifest(directory, manifest);
      await assert.rejects(buildPackage({ directory }), /one.*skill.*connector/);
    });
  }
});

test("anonymous auth, missing OAuth reference, and static tool descriptions are rejected", async () => {
  for (const mutate of [
    (r) => { r.authorization.type = "None"; },
    (r) => { delete r.authorization.referenceId; },
    (r) => { r.authorization.referenceId = " "; },
    (r) => { r.mcpToolDescription = { file: "./tools.json" }; },
  ]) {
    await fixture(async (directory, manifest) => {
      mutate(manifest.agentConnectors[0].toolSource.remoteMcpServer);
      await saveManifest(directory, manifest);
      await assert.rejects(buildPackage({ directory }), /OAuthPluginVault|Invalid manifest/);
    });
  }
});

test("endpoint must be HTTPS /mcp without embedded credentials or query", async () => {
  for (const url of [
    "http://demo.contoso.com/mcp", "https://demo.contoso.com/",
    "https://user:password@demo.contoso.com/mcp",
    "https://demo.contoso.com/mcp?token=secret", "https://demo.contoso.com/mcp#fragment",
  ]) {
    await fixture(async (directory, manifest) => {
      manifest.agentConnectors[0].toolSource.remoteMcpServer.mcpServerUrl = url;
      await saveManifest(directory, manifest);
      await assert.rejects(buildPackage({ directory }), /HTTPS|Invalid manifest/);
    });
  }
});

test("extra files including local credentials cannot enter the package", async () => {
  await fixture(async (directory) => {
    await writeFile(join(directory, ".env"), "LOCAL_TEST_VALUE=not-a-secret");
    await assert.rejects(buildPackage({ directory }), /must contain only/);
  });
});

test("symlinks cannot enter the package", async () => {
  await fixture(async (directory) => {
    await rm(join(directory, "color.png"));
    await symlink(join(directory, "outline.png"), join(directory, "color.png"));
    await assert.rejects(buildPackage({ directory }), /symlinks are not allowed/);
  });
});

test("missing package files and wrong icon sizes fail validation", async () => {
  await fixture(async (directory) => {
    await rm(join(directory, "outline.png"));
    await assert.rejects(buildPackage({ directory }), /must contain only/);
  });
  await fixture(async (directory) => {
    await cp(join(directory, "outline.png"), join(directory, "color.png"));
    await assert.rejects(buildPackage({ directory }), /192x192 PNG/);
  });
});

test("skill folder and frontmatter name must match", async () => {
  await fixture(async (directory) => {
    const file = join(directory, "skills/entra-mcp-demo/SKILL.md");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace("name: entra-mcp-demo", "name: wrong-name"));
    await assert.rejects(buildPackage({ directory }), /Skill frontmatter/);
  });
});

test("pinned schema retains the reviewed checksum", async () => {
  const schema = await readFile(new URL("../schema/MicrosoftTeams.v1.29.schema.json", import.meta.url));
  assert.equal(createHash("sha256").update(schema).digest("hex"),
    "53e860fd650fd03fe587379d92af6c91374e791f041ce3f26c92d5e74aeafa0b");
});

test("CLI rejects malformed tags, unreplaced placeholders, and conflicting options", () => {
  for (const args of [
    ["--tag", "releases/plugin/v1.2.3-rc"],
    ["--configured"],
    ["--tag", "releases/plugin/v1.2.3", "--version", "1.2.3"],
    ["--tag", "releases/plugin/v1.2.3", "--configured"],
  ]) {
    const result = spawnSync(process.execPath, ["scripts/package.mjs", ...args], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Expected a tag|placeholders|cannot be combined/);
  }
});

test("CLI produces the release asset with version-matched manifest", async () => {
  const output = new URL("../build/entra-mcp-cowork-plugin-template-9.8.7.zip", import.meta.url);
  const result = spawnSync(process.execPath, [
    "scripts/package.mjs", "--tag", "releases/plugin/v9.8.7",
  ], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Configuration template \(not install-ready\)/);
    const entries = unzipSync(await readFile(output));
    assert.equal(JSON.parse(strFromU8(entries["manifest.json"])).version, "9.8.7");
  } finally {
    await rm(output, { force: true });
  }
});

test("ZIP timestamps are reproducible across time zones", () => {
  const checksums = ["UTC", "Pacific/Honolulu"].map((timezone) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { buildPackage } from "./scripts/package.mjs";
      import { createHash } from "node:crypto";
      console.log(createHash("sha256").update((await buildPackage()).bytes).digest("hex"));
    `], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, TZ: timezone },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  });
  assert.equal(checksums[0], checksums[1]);
});
