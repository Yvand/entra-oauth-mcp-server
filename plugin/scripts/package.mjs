import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Ajv from "ajv-draft-04";
import addFormats from "ajv-formats";
import { zipSync } from "fflate";
import schema from "../schema/MicrosoftTeams.v1.29.schema.json" with { type: "json" };

const pluginDirectory = fileURLToPath(new URL("../", import.meta.url));
const appDirectory = resolve(pluginDirectory, "appPackage");
const skillFolder = "skills/entra-mcp-demo";
export const packageFiles = [
  "color.png",
  "manifest.json",
  "outline.png",
  `${skillFolder}/SKILL.md`,
];
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

export function versionFromTag(tag) {
  const prefix = "releases/plugin/v";
  if (!tag.startsWith(prefix) || !versionPattern.test(tag.slice(prefix.length))) {
    throw new Error("Expected a tag in the form releases/plugin/vX.Y.Z (no prerelease or leading zeros).");
  }
  return tag.slice(prefix.length);
}

async function listFiles(directory, root = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path, root));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
    else throw new Error(`Unsupported package entry (symlinks are not allowed): ${path}`);
  }
  return files.sort();
}

function validateIcon(bytes, size, name) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)
    || bytes.toString("ascii", 12, 16) !== "IHDR"
    || bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size) {
    throw new Error(`${name} must be a ${size}x${size} PNG.`);
  }
}

export async function buildPackage({
  directory = appDirectory,
  version,
  configured = false,
} = {}) {
  const files = await listFiles(directory);
  if (JSON.stringify(files) !== JSON.stringify(packageFiles)) {
    throw new Error(`Package must contain only: ${packageFiles.join(", ")}`);
  }
  const entries = Object.fromEntries(await Promise.all(
    files.map(async (name) => [name, await readFile(resolve(directory, name))]),
  ));
  const manifest = JSON.parse(entries["manifest.json"].toString("utf8"));
  if (version !== undefined) manifest.version = version;
  if (!versionPattern.test(manifest.version)) {
    throw new Error("Plugin version must be X.Y.Z (no prerelease or leading zeros).");
  }
  if (!validateSchema(manifest)) {
    throw new Error(`Invalid manifest: ${ajv.errorsText(validateSchema.errors)}`);
  }
  if (manifest.manifestVersion !== "1.29"
    || manifest.agentSkills?.length !== 1
    || manifest.agentSkills[0].folder !== `./${skillFolder}`
    || manifest.agentConnectors?.length !== 1) {
    throw new Error("Expected manifest v1.29, one entra-mcp-demo skill, and one connector.");
  }
  const connector = manifest.agentConnectors[0];
  const remote = connector.toolSource?.remoteMcpServer;
  if (connector.id !== "entra-mcp"
    || remote?.authorization?.type !== "OAuthPluginVault"
    || !remote.authorization.referenceId?.trim()
    || remote.mcpToolDescription !== undefined) {
    throw new Error("Expected the entra-mcp OAuthPluginVault connector with a referenceId and dynamic tool discovery.");
  }
  const endpoint = new URL(remote.mcpServerUrl);
  if (endpoint.protocol !== "https:" || endpoint.pathname !== "/mcp"
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("MCP endpoint must be an HTTPS URL ending in /mcp without credentials, query, or fragment.");
  }
  if (manifest.icons.color !== "color.png" || manifest.icons.outline !== "outline.png") {
    throw new Error("Manifest icons must reference color.png and outline.png.");
  }
  const skill = entries[`${skillFolder}/SKILL.md`].toString("utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill)?.[1];
  if (!frontmatter || !/^name: entra-mcp-demo\r?$/m.test(frontmatter)
    || !/^description: \S.+$/m.test(frontmatter)) {
    throw new Error("Skill frontmatter must name entra-mcp-demo and include a description.");
  }
  validateIcon(entries["color.png"], 192, "color.png");
  validateIcon(entries["outline.png"], 32, "outline.png");
  if (configured) {
    const serialized = JSON.stringify(manifest);
    if (serialized.includes("REPLACE_")
      || [remote.mcpServerUrl, ...Object.values(manifest.developer).filter(
        (value) => typeof value === "string" && value.startsWith("https://"),
      )].some((value) => {
        const host = new URL(value).hostname;
        return /(^|\.)example\.(com|net|org)$/.test(host) || host.endsWith(".invalid");
      })) {
      throw new Error("Replace endpoint, OAuth reference, and developer placeholders before configured packaging.");
    }
  }
  entries["manifest.json"] = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  // A fixed ZIP timestamp keeps repeated builds of the same input identical.
  const zippedEntries = Object.fromEntries(Object.entries(entries).map(
    ([name, bytes]) => [name, [bytes, { mtime: new Date(2020, 0, 1) }]],
  ));
  const kind = configured ? "configured" : "template";
  return {
    manifest,
    fileName: `entra-mcp-cowork-plugin-${kind}-${manifest.version}.zip`,
    bytes: zipSync(zippedEntries),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
      version: { type: "string" },
      configured: { type: "boolean", default: false },
    },
  });
  if (values.tag && (values.version || values.configured)) {
    throw new Error("--tag cannot be combined with --version or --configured.");
  }
  const result = await buildPackage({
    version: values.tag ? versionFromTag(values.tag) : values.version,
    configured: values.configured,
  });
  const output = resolve(pluginDirectory, "build", result.fileName);
  await mkdir(resolve(pluginDirectory, "build"), { recursive: true });
  await writeFile(output, result.bytes);
  console.log(`${values.configured ? "Configured package (not live-tested)" : "Configuration template (not install-ready)"}: ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
