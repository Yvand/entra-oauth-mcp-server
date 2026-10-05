# Testing

[Project overview](../README.md) | [Local development](local-development.md) | [Azure deployment](azure-deployment.md) | [Troubleshooting and cleanup](operations.md)

There are two distinct kinds of verification:

| Kind | What it checks | Real configuration required? |
| --- | --- | --- |
| Offline automated tests | Application behavior with local signing keys and a mocked cleanup CLI | No Entra tenant, `.env`, running deployment, or Azure subscription |
| Live smoke tests | A running local or Azure server, its actual configuration, and real Entra tokens | Yes: API registration/scope and a token-acquiring client |

`npm test` does **not** target your local development server or Azure endpoint. Run the live checks separately after either deployment.

## Offline automated tests

From the repository root, with Node.js 24+ and npm:

```bash
npm install
npm test
npm run typecheck
npm run build
```

Targeted tests:

```bash
npx vitest run test/auth.test.ts
npx vitest run test/server.test.ts test/hooks.test.ts
npx vitest run test/auth.test.ts -t "authenticate"
```

| File | Coverage |
| --- | --- |
| `test/auth.test.ts` | Bearer header handling, scope enforcement, claim allow-listing, valid/expired/wrong-issuer/wrong-audience/untrusted-key tokens, and configuration |
| `test/server.test.ts` | Own loopback HTTP server; public endpoints, 401/403/405 paths, malformed authenticated JSON, initialize/list/whoami |
| `test/hooks.test.ts` | Mocked Azure CLI; owned-object deletion order, ownership mismatches, Deleted items retry, and postdown-only wiring |

Token tests generate RSA keys and sign tokens locally with `jose`; they do not contact Entra. Hook tests do not delete real objects. Bash must be available for the Bash hook cases; PowerShell cases are included only when `pwsh` is available. On Windows, run the full suite in a compatible Bash-capable environment such as WSL. Type checking includes source and tests; build compiles the production source. There is no dedicated lint script.

## Live verification (local or Azure)

Start [locally](local-development.md) or finish [azd deployment](azure-deployment.md) first. Use the server **base URL**, not an endpoint already ending in `/mcp`.

### 1. Select the target and registration values

For local use, set these in your test terminal using the values from your registration:

```bash
BASE_URL="http://127.0.0.1:3000"
ENTRA_TENANT_ID="<directory-tenant-id>"
REQUESTED_SCOPE="api://<api-application-client-id>/mcp.invoke"
```

PowerShell:

```powershell
$BASE_URL = "http://127.0.0.1:3000"
$ENTRA_TENANT_ID = "<directory-tenant-id>"
$REQUESTED_SCOPE = "api://<api-application-client-id>/mcp.invoke"
```

For Azure, select the correct environment and read its values. Bash:

```bash
azd env select mcp-dev || exit 1
BASE_URL=$(azd env get-value SERVICE_MCP_URI) || exit 1
ENTRA_TENANT_ID=$(azd env get-value ENTRA_TENANT_ID) || exit 1
# Default Application ID URI only; replace for a manual custom URI.
API_APP_ID=$(azd env get-value ENTRA_AUDIENCE) || exit 1
SCOPE_NAME=$(azd env get-value MCP_REQUIRED_SCOPE) || exit 1
REQUESTED_SCOPE="api://$API_APP_ID/$SCOPE_NAME"
```

PowerShell:

```powershell
azd env select mcp-dev
if ($LASTEXITCODE -ne 0) { throw "Cannot select azd environment" }
$BASE_URL = azd env get-value SERVICE_MCP_URI
if ($LASTEXITCODE -ne 0) { throw "Cannot read base URL" }
$ENTRA_TENANT_ID = azd env get-value ENTRA_TENANT_ID
if ($LASTEXITCODE -ne 0) { throw "Cannot read tenant ID" }
$API_APP_ID = azd env get-value ENTRA_AUDIENCE
if ($LASTEXITCODE -ne 0) { throw "Cannot read API audience" }
$SCOPE_NAME = azd env get-value MCP_REQUIRED_SCOPE
if ($LASTEXITCODE -ne 0) { throw "Cannot read scope name" }
$REQUESTED_SCOPE = "api://$API_APP_ID/$SCOPE_NAME"
```

The construction above assumes one bare API ID and the default `api://` URI. For a custom identifier URI or multiple configured audiences, use the full scope from the actual API registration; do not concatenate a comma-separated audience list. `MCP_CLIENT_ID` is needed by your own OAuth client, but Azure CLI token acquisition uses Azure CLI's own client ID.

### 2. Check public endpoints and unauthenticated behavior

Bash:

```bash
BASE_URL="${BASE_URL%/}"
INITIALIZE='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0"}}}'

curl -sS -i "$BASE_URL/healthz"
curl -sS -i "$BASE_URL/.well-known/oauth-protected-resource"
curl -sS -i "$BASE_URL/mcp"
curl -sS -i -X DELETE "$BASE_URL/mcp"
curl -sS -i -X POST "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d "$INITIALIZE"
```

PowerShell 7+ uses `Invoke-WebRequest -SkipHttpErrorCheck` so expected 401/405 responses remain inspectable:

```powershell
$BASE_URL = $BASE_URL.TrimEnd("/")
$INITIALIZE = @{
    jsonrpc = "2.0"; id = 1; method = "initialize"
    params = @{
        protocolVersion = "2025-06-18"; capabilities = @{}
        clientInfo = @{ name = "smoke-test"; version = "1.0" }
    }
}
Invoke-WebRequest "$BASE_URL/healthz" -SkipHttpErrorCheck
Invoke-WebRequest "$BASE_URL/.well-known/oauth-protected-resource" -SkipHttpErrorCheck
Invoke-WebRequest "$BASE_URL/mcp" -SkipHttpErrorCheck
Invoke-WebRequest "$BASE_URL/mcp" -Method Delete -SkipHttpErrorCheck
$unauthenticated = Invoke-WebRequest "$BASE_URL/mcp" -Method Post `
    -ContentType "application/json" -Headers @{ Accept = "application/json, text/event-stream" } `
    -Body ($INITIALIZE | ConvertTo-Json -Depth 10 -Compress) -SkipHttpErrorCheck
$unauthenticated.StatusCode
$unauthenticated.Headers["WWW-Authenticate"]
$unauthenticated.Content
```

| Request | Expected |
| --- | --- |
| `GET /healthz` | 200; JSON includes `status: "ok"`, server name, version |
| `GET /.well-known/oauth-protected-resource` | 200; `resource` matches the base URL and authority points at the configured tenant |
| `GET` or `DELETE /mcp` | 405; `Allow: POST` |
| `POST /mcp` without token | 401; `WWW-Authenticate` has `invalid_request` and the public metadata URL |

Metadata's current scope-format limitation is described in [OAuth client integration](operations.md#oauth-client-integration); use the registration's full scope for token acquisition.

### 3. Acquire a real delegated API token

Azure CLI must be [authorized for the API scope](entra-app-registrations.md#optional-azure-cli-authorization-for-smoke-tests). Sign in to the token-issuing tenant, then request that scope:

```bash
az login --tenant "$ENTRA_TENANT_ID" || exit 1
TOKEN=$(az account get-access-token --scope "$REQUESTED_SCOPE" --query accessToken -o tsv) || exit 1
test -n "$TOKEN" || { printf 'No access token returned\n' >&2; exit 1; }
```

PowerShell:

```powershell
az login --tenant $ENTRA_TENANT_ID
if ($LASTEXITCODE -ne 0) { throw "Azure CLI login failed" }
$TOKEN = az account get-access-token --scope $REQUESTED_SCOPE --query accessToken -o tsv
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($TOKEN)) {
    throw "Cannot acquire delegated API token"
}
```

If tenant policy blocks Azure CLI, use your registered client's Authorization Code + PKCE flow instead, with its own client ID and callback. Place the resulting **access token** (not an ID token) in the test terminal's `TOKEN` variable. No client implementation is included here. Do not relax audience or scope checks to make the test pass.

Never print tokens, enable shell tracing for these commands, commit them, or paste them into an external decoder. Azure CLI's cache can retain credentials beyond this terminal session; follow your organization's workstation/sign-out policy.

### 4. Exercise authenticated MCP requests

Use the same token on **every** request. No session ID is needed.

Bash helper and requests:

```bash
mcp() {
  curl -sS -i -X POST "$BASE_URL/mcp" \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d "$1"
}
mcp "$INITIALIZE"
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello"}}}'
```

PowerShell helper avoids native JSON argument quoting:

```powershell
function Send-Mcp {
    param([hashtable]$Request)
    $response = Invoke-WebRequest "$BASE_URL/mcp" -Method Post `
        -ContentType "application/json" `
        -Headers @{ Authorization = "Bearer $TOKEN"; Accept = "application/json, text/event-stream" } `
        -Body ($Request | ConvertTo-Json -Depth 10 -Compress) -SkipHttpErrorCheck
    $response.StatusCode
    $response.Content
}
Send-Mcp $INITIALIZE
Send-Mcp @{ jsonrpc = "2.0"; id = 2; method = "tools/list"; params = @{} }
Send-Mcp @{
    jsonrpc = "2.0"; id = 3; method = "tools/call"
    params = @{ name = "whoami"; arguments = @{} }
}
Send-Mcp @{
    jsonrpc = "2.0"; id = 4; method = "tools/call"
    params = @{ name = "echo"; arguments = @{ message = "hello" } }
}
```

On Windows, use `curl.exe` if translating Bash curl examples; `curl` may resolve to a PowerShell alias in older shells, and Bash continuations are not valid PowerShell syntax.

Expect HTTP 200 and a JSON-RPC `result` rather than `error`. Initialization returns protocol/server information. `tools/list` includes `echo` and `whoami`. `whoami` returns `result.structuredContent` with the caller's subject, scopes, issuer, audience, and available allow-listed identity claims. `echo` returns text `<subject>: hello`. Identity output can still contain personal data; do not post it publicly.

A malformed or expired token should yield **401 `invalid_token`**. An otherwise valid token for this API that lacks the required delegated scope yields **403 `insufficient_scope`**, with the short required scope in the challenge. Obtaining that latter token may require a separate allowed scope/permission configuration; the offline suite provides a reproducible 403 check without altering your registrations. A Graph token is a wrong-audience 401 test, not a missing-scope 403 test.

After checking, clear the terminal variable:

```bash
unset TOKEN
```

```powershell
Remove-Variable TOKEN
```

This does not clear Azure CLI's token cache. Use [troubleshooting](operations.md#troubleshooting) for failures and [cleanup](operations.md#cleanup) when finished.
