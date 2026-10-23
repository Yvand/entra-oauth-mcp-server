import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TokenIdentity } from "./auth.js";

export const SERVER_NAME = "entra-oauth-mcp-server";
export const SERVER_VERSION = "1.0.0";

/**
 * Builds a fresh MCP server bound to the identity of the caller whose access
 * token was validated for this request.
 */
export function createMcpServer(identity: TokenIdentity): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Tools require a Microsoft Entra ID access token with the configured delegated scope.",
    },
  );

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Returns the safe identity claims from the validated Entra ID access token.",
      inputSchema: {},
      outputSchema: {
        subject: z.string(),
        objectId: z.string().optional(),
        tenantId: z.string().optional(),
        clientId: z.string().optional(),
        username: z.string().optional(),
        name: z.string().optional(),
        scopes: z.array(z.string()),
        issuer: z.string(),
        audience: z.string(),
        issuedAt: z.number().optional(),
        expiresAt: z.number().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      content: [
        { type: "text" as const, text: JSON.stringify(identity, null, 2) },
      ],
      structuredContent: identity as unknown as Record<string, unknown>,
    }),
  );

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echoes a message back, prefixed with the caller's subject.",
      inputSchema: { message: z.string().min(1).max(4000) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ message }) => ({
      content: [
        { type: "text" as const, text: `${identity.subject}: ${message}` },
      ],
    }),
  );

  return server;
}
