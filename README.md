# Entra MCP server and Microsoft 365 Copilot plugin

A small learning demo: an Entra-protected MCP server and a **Microsoft 365 Copilot Cowork plugin** with one skill that calls its `whoami` and `echo` tools.

| Component | Start here |
| --- | --- |
| `server/` | [Server overview](server/README.md), [local development](server/docs/local-development.md), [Azure deployment](server/docs/azure-deployment.md) |
| `plugin/` | [Configure, package, and install the Cowork plugin](plugin/README.md) |

The server and plugin have independent setup and versioning. Run server npm, Docker, and `azd` commands from `server/`, not the repository root. The plugin requires an accessible HTTPS server and a manually configured OAuth registration; a release ZIP is a **configuration template**, not an install-ready deployment.

## Existing checkouts

The server previously lived at the repository root. Its tracked files now live in `server/`; existing untracked local configuration is not moved automatically.

Before using an existing environment, stop local server processes and back up your local configuration privately. Move your root `.env` (and any `.env.local`) into `server/`, preserving its values. For an existing azd deployment, move only the intended `.azure/<environment>/` state directory to `server/.azure/<environment>/` and preserve the selected-environment configuration in `.azure/config.json` if present. Inspect destinations first; do not overwrite an existing environment.

Then run `azd env list` and select the same environment **from `server/`**, verifying subscription, resource group, and registration IDs before provisioning or teardown. Do not create a new environment or rename the old one as part of this migration: ownership tags depend on the environment and subscription. Do not delete remote resources or commit local state. Reinstall Node dependencies from `server/` rather than moving an old `node_modules` directory.

## Plugin releases

Push a tag such as `releases/plugin/v1.2.3` to publish a GitHub Release containing a versioned plugin template ZIP. See the [plugin release instructions](plugin/README.md#releases). This does not deploy the server, install into a tenant, or publish to the Microsoft 365 store.
