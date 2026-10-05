# Local development

[Project overview](../README.md) | [App registrations](entra-app-registrations.md) | [Testing](testing.md) | [Operations and cleanup](operations.md)

Run the server directly with Node.js **24+** and npm. Local startup does not use `azd` and does not create Entra registrations automatically.

## 1. Create or reuse app registrations

Follow either the [manual portal setup](entra-app-registrations.md#manual-portal-setup) or the [Bash/PowerShell scripts](entra-app-registrations.md#scripted-setup). You need an API registration exposing a delegated scope and a client capable of acquiring an access token for it.

Record the tenant ID, API application ID, calling-client application ID, and full requested scope. Set the API to issue v2 access tokens. If using Azure CLI for live checks, also read [Azure CLI authorization](entra-app-registrations.md#optional-azure-cli-authorization-for-smoke-tests).

## 2. Configure the server

From the repository root:

```bash
npm install
cp .env.example .env
```

On PowerShell, use `Copy-Item .env.example .env` instead of `cp`. Edit the resulting file:

```dotenv
ENTRA_TENANT_ID=<directory-tenant-id>
ENTRA_AUDIENCE=<api-application-client-id>
MCP_REQUIRED_SCOPE=mcp.invoke
PORT=3000
HOST=127.0.0.1
PUBLIC_BASE_URL=http://127.0.0.1:3000
```

Replace the placeholders with real values; the zero GUIDs in the sample are not usable registration settings. `ENTRA_AUDIENCE` is the **API ID**, not the caller's client ID and not the `api://` URI.

The server requires tenant and audience values; the short required scope defaults to `mcp.invoke`. Use the same scope name you exposed. The calling-client ID and full requested scope belong in your OAuth client's configuration, not the server's configuration.

If you keep those client values in environment variables, set them in the terminal running your client. These names are bookkeeping conventions; configure your chosen client to use them explicitly.

```bash
export MCP_CLIENT_ID="<calling-client-application-id>"
export REQUESTED_SCOPE="api://<api-application-client-id>/mcp.invoke"
```

```powershell
$env:MCP_CLIENT_ID = "<calling-client-application-id>"
$env:REQUESTED_SCOPE = "api://<api-application-client-id>/mcp.invoke"
```

`dotenv` loads `.env` when the server starts. Existing process environment variables take precedence, so check for stale exported values if behavior differs from the file. `.env` is git-ignored; do not commit it or put access tokens in it.

Optional `ENTRA_ISSUER` and `ENTRA_JWKS_URI` override tenant-derived URLs. Normally leave them unset. `PUBLIC_BASE_URL` controls the URL advertised in OAuth metadata/challenges; use the externally visible HTTPS URL when behind a proxy. See the [configuration reference](operations.md#server-configuration).

## 3. Start the server

Watch mode:

```bash
npm run dev
```

Or compile and run the production bundle:

```bash
npm run build
npm start
```

The default listener is `http://127.0.0.1:3000`. Keep this terminal running and use a second terminal for [live verification](testing.md#live-verification-local-or-azure). A successful health check alone does not prove token validation works.

Keep `HOST=127.0.0.1` for loopback-only development. Binding to `0.0.0.0` exposes the listener on all interfaces; configure network access and TLS appropriately before making it reachable remotely.

## Optional local container

Docker is required only for this path, not direct Node.js startup:

```bash
docker build -t entra-oauth-mcp-server:local .
docker run --rm --name entra-oauth-mcp-local \
  -p 127.0.0.1:3000:3000 --env-file .env -e HOST=0.0.0.0 \
  entra-oauth-mcp-server:local
```

Run the same Docker command on PowerShell as one line (Bash backslashes are not PowerShell continuations). The explicit `HOST` override is necessary because the copied `.env` uses loopback, which would otherwise bind only inside the container. The host port remains loopback-only. The image runs as a non-root user.

## Test and stop

[Automated tests](testing.md#offline-automated-tests) do not require this running server, a real `.env`, or Entra access. For live checks, keep the server running and use a real API token.

Stop foreground watch/production startup with **Ctrl+C**. For a container, use `docker stop entra-oauth-mcp-local`; `--rm` removes the stopped container, not its image. Entra registrations remain until you deliberately [remove them](operations.md#independently-managed-registrations).
