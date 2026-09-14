import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
} from "jose";
import { createApp } from "../src/app.js";
import type { JwtVerifier } from "../src/auth.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({
  ENTRA_TENANT_ID: "tenant-id",
  ENTRA_AUDIENCE: "api://client-id",
  MCP_REQUIRED_SCOPE: "mcp.invoke",
  PUBLIC_BASE_URL: "http://mcp.test",
} as NodeJS.ProcessEnv);

let httpServer: Server;
let baseUrl: string;
let sign: (claims: Record<string, unknown>) => Promise<string>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), alg: "RS256", kid: "test-key" }],
  });

  sign = (claims) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(config.issuer)
      .setAudience(config.audiences[0]!)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

  const verify: JwtVerifier = async (token) => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.audiences,
      algorithms: ["RS256"],
    });
    return payload;
  };

  httpServer = createApp(config, verify).listen(0, "127.0.0.1");
  await new Promise((resolve) => httpServer.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
});

async function mcpRequest(body: unknown, token?: string): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  },
};

describe("unauthenticated access", () => {
  it("rejects requests without a token and advertises the resource metadata", async () => {
    const response = await mcpRequest(initializeRequest);
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="invalid_request"');
    expect(challenge).toContain(
      'resource_metadata="http://mcp.test/.well-known/oauth-protected-resource"',
    );
  });

  it("rejects a garbage token with 401 invalid_token", async () => {
    const response = await mcpRequest(initializeRequest, "not-a-jwt");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
  });

  it("rejects a valid token missing mcp.invoke with 403", async () => {
    const token = await sign({ sub: "sub-1", scp: "User.Read" });
    const response = await mcpRequest(initializeRequest, token);
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope"',
    );
  });
});

describe("public endpoints", () => {
  it("serves health without a token", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("serves protected-resource metadata", async () => {
    const response = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resource: "http://mcp.test",
      scopes_supported: ["api://client-id/mcp.invoke"],
    });
  });

  it("rejects GET on the MCP endpoint", async () => {
    const response = await fetch(`${baseUrl}/mcp`);
    expect(response.status).toBe(405);
  });

  it("returns a JSON-RPC parse error for malformed authenticated bodies", async () => {
    const token = await sign({ sub: "sub-1", scp: "mcp.invoke" });
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32700 },
    });
  });
});

describe("authenticated MCP session", () => {
  it("initializes, lists tools and returns identity claims from whoami", async () => {
    const token = await sign({
      sub: "sub-1",
      oid: "oid-1",
      tid: "tenant-id",
      azp: "client-id",
      preferred_username: "user@contoso.com",
      name: "Test User",
      scp: "mcp.invoke",
    });

    const initResponse = await mcpRequest(initializeRequest, token);
    expect(initResponse.status).toBe(200);

    const listResponse = await mcpRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      token,
    );
    const listed = (await listResponse.json()) as {
      result: { tools: { name: string }[] };
    };
    expect(listed.result.tools.map((t) => t.name).sort()).toEqual([
      "echo",
      "whoami",
    ]);

    const callResponse = await mcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "whoami", arguments: {} },
      },
      token,
    );
    const called = (await callResponse.json()) as {
      result: { structuredContent: Record<string, unknown> };
    };
    expect(called.result.structuredContent).toMatchObject({
      subject: "sub-1",
      objectId: "oid-1",
      tenantId: "tenant-id",
      clientId: "client-id",
      username: "user@contoso.com",
      scopes: ["mcp.invoke"],
    });
  });
});
