# entra-oauth-mcp-server

A small TypeScript [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server protected by **Microsoft Entra ID delegated access tokens**. Use it to explore how an MCP API authenticates a signed-in user, enforces a permission, and exposes tools bound to that user's identity.

The server uses Express and the official MCP SDK over **stateless Streamable HTTP**, with JSON responses. Every `POST /mcp` request validates the token's signature, issuer, audience, and validity period against the tenant's signing keys, then requires the configured delegated scope (`mcp.invoke` by default).

| Tool | Purpose |
| --- | --- |
| `whoami` | Return an allow-listed set of identity claims from the validated token |
| `echo` | Echo a message prefixed with the caller's subject |

This is an API, not an OAuth authorization server or a client application. It does not sign users in, issue tokens, or require a client secret to validate them. There is no database or MCP session state. Clients obtain a token from Entra and send it on each MCP request; app-only permissions are not a substitute for the required delegated scope.

## Choose a setup path

Two app registrations are involved: the **API** and the **calling client**. The API's application ID is the token audience; the client's application ID identifies the application signing the user in. They are not interchangeable.

| Scenario | Registration setup | Start here |
| --- | --- | --- |
| Run locally | Create registrations through the portal or copy/paste scripts; no `azd` required | [Local development](docs/local-development.md) |
| Deploy to Azure with new registrations | Set `CREATE_ENTRA_APP_REGISTRATIONS=true`; `azd` creates them during provisioning | [Azure deployment](docs/azure-deployment.md#create_entra_app_registrationstrue) |
| Deploy to Azure with existing registrations | Set `CREATE_ENTRA_APP_REGISTRATIONS=false` (the default); create or reuse registrations through the portal or scripts | [Azure deployment](docs/azure-deployment.md#create_entra_app_registrationsfalse-default) |

After setup, follow [testing](docs/testing.md) for both offline tests and live endpoint checks. Follow [operations and cleanup](docs/operations.md) to remove resources safely.

## Prerequisites

| Task | Requirements |
| --- | --- |
| Local development and automated tests | Node.js **24+**, npm; Bash for cleanup-hook tests (PowerShell cases also run when `pwsh` is available) |
| Register apps manually | Entra tenant access and permission to register/configure apps; appropriate consent permissions |
| Register apps using scripts | [Azure CLI (`az`)](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli), Bash or PowerShell 7+, and permission to create registrations/service principals and grant admin consent |
| Azure deployment | [Azure Developer CLI (`azd`)](https://aka.ms/azd-install), Azure subscription, and permissions to provision resources and assign roles |
| Azure Entra cleanup and CLI token checks | Azure CLI signed into the correct tenant; cleanup also requires suitable Entra privileges |

The Azure deployment uses ACR remote builds, so local Docker is not required for that build path. Docker is needed for local container builds or an optional local-build fallback. Azure RBAC and Entra directory roles are separate; see the guides for scenario-specific permissions.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `src/config.ts` | Load server configuration and derive issuer/JWKS URLs |
| `src/auth.ts` | Verify bearer tokens, enforce scopes, map identity claims |
| `src/mcp-server.ts` | Register tools on a request-scoped MCP server |
| `src/app.ts` | HTTP routing, authentication, health, and OAuth metadata |
| `src/index.ts` | Start the server |
| `test/auth.test.ts` | Token validation, scope enforcement, claim mapping, and configuration tests |
| `test/server.test.ts` | Isolated HTTP/MCP round-trip tests with locally signed tokens |
| `test/hooks.test.ts` | Entra cleanup-hook tests with a mocked Azure CLI |
| `.env.example` | Local server configuration template |
| `Dockerfile` | Multi-stage Node.js container build; non-root runtime |
| `azure.yaml` | `azd` service definition, remote build, and `postdown` hooks |
| `infra/main.bicep`, `infra/main.parameters.json` | Azure infrastructure and `azd` parameter mapping |
| `infra/entra/` | Optional declarative Entra app registrations |
| `infra/modules/` | Registry pull-role assignment and deployed-image lookup |
| `infra/hooks/` | Ownership-checked Entra deletion/purge after Azure teardown |
| `docs/` | Version-controlled setup, testing, and operations guides |

## Documentation

- [Entra app registrations](docs/entra-app-registrations.md): portal setup, Bash/PowerShell scripts, consent, and ID/scope mapping.
- [Local development](docs/local-development.md): configure `.env` and run the server without `azd`.
- [Azure deployment](docs/azure-deployment.md): deploy through `azd`, choose registration ownership, and retrieve outputs.
- [Testing](docs/testing.md): run the automated suite and verify a local or Azure endpoint with real tokens.
- [Operations and cleanup](docs/operations.md): configuration/endpoints, OAuth clients, troubleshooting, security, and teardown.

These Markdown guides live alongside the code rather than in a separate wiki so documentation updates can be reviewed with the implementation.
