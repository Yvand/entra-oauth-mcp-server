# Copilot instructions for `entra-oauth-mcp-server`

## Local setup and validation

Use the repository README as the source of truth for Entra app registration and environment configuration before running the server locally.

- Install dependencies: `npm install`
- Create local env from the sample: `cp .env.example .env`
- Start in watch mode: `npm run dev`
- Build the production bundle: `npm run build`
- Run the full test suite: `npm test`
- Run a single test file: `npx vitest run test/auth.test.ts`
- Run a single test name: `npx vitest run test/auth.test.ts -t "authenticate"`
- Type-check the project: `npm run typecheck`

There is no dedicated lint script in `package.json`; prefer `npm run typecheck` and the Vitest suite for validation when making changes.

## High-level architecture

This repository is a small TypeScript HTTP server for an OAuth-protected Model Context Protocol endpoint.

- `src/config.ts`: loads required environment values (`ENTRA_TENANT_ID`, `ENTRA_AUDIENCE`, `MCP_REQUIRED_SCOPE`), validates them, and derives the Entra issuer and JWKS URLs.
- `src/auth.ts`: validates bearer tokens against the tenant JWKS, checks issuer/audience/expiry, extracts the identity, and enforces the required delegated scope from the `scp` claim.
- `src/mcp-server.ts`: creates an MCP server instance for each authenticated request and registers the tools `whoami` and `echo`.
- `src/app.ts`: wires Express + the stateless `StreamableHTTPServerTransport`, enforces auth before body parsing, and exposes `/mcp`, `/healthz`, and the OAuth protected-resource metadata endpoint.
- `src/index.ts`: bootstraps the app and logs the expected issuer, audience, and scope.
- `test/*.test.ts`: verifies token validation, config handling, and authenticated HTTP/MCP request flows end-to-end.

The app is intentionally designed around a single, simple pattern: authenticate the request, then create a request-scoped MCP server bound to the caller's token identity.

## Repository-specific conventions

- Treat this as an Entra-protected MCP API, not a generic Express API. Every call to `/mcp` must carry a valid bearer token and the configured delegated scope.
- `ENTRA_AUDIENCE` may contain multiple comma-separated values. Keep it aligned with the actual `aud` claim in issued tokens; do not assume only the Application ID URI form is valid.
- `scp` is the delegated scope source. The code expects a space-delimited scope string and throws `insufficient_scope` when the required delegated permission is absent.
- The `whoami` tool intentionally exposes only a safe, minimal set of claims (`sub`, `oid`, `tid`, `azp`/`appid`, `preferred_username`/`upn`, `name`, `scp`, etc.) and deliberately drops other payload data.
- The app uses stateless MCP transport and rejects non-POST methods on `/mcp`; no session state should be introduced without updating both the auth flow and the tests.
- The `PUBLIC_BASE_URL` value is used in OAuth metadata and `WWW-Authenticate` challenge headers; set it correctly when behind a reverse proxy or non-local hostname.
- Follow the repo's testing style: create local JWT test keys with `jose` for auth validation tests instead of mocking external Entra behavior.

## Required configuration

Before running or testing locally, ensure these values are present in `.env`:

- `ENTRA_TENANT_ID`
- `ENTRA_AUDIENCE`
- `MCP_REQUIRED_SCOPE`

The project also supports optional overrides for custom issuers/JWKS endpoints and the public base URL, as shown in `.env.example`.
