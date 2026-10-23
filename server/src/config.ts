import "dotenv/config";

export interface AppConfig {
  tenantId: string;
  audiences: string[];
  issuer: string;
  jwksUri: string;
  requiredScope: string;
  port: number;
  host: string;
  publicBaseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      throw new Error(
        `Missing required environment variable ${name}. See .env.example.`,
      );
    }
    return value;
  };

  const tenantId = required("ENTRA_TENANT_ID");
  const audiences = required("ENTRA_AUDIENCE")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  if (audiences.length === 0) {
    throw new Error("ENTRA_AUDIENCE must contain at least one value.");
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${env.PORT}`);
  }
  const host = env.HOST?.trim() || "127.0.0.1";

  return {
    tenantId,
    audiences,
    issuer:
      env.ENTRA_ISSUER?.trim() ||
      `https://login.microsoftonline.com/${tenantId}/v2.0`,
    jwksUri:
      env.ENTRA_JWKS_URI?.trim() ||
      `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
    requiredScope: env.MCP_REQUIRED_SCOPE?.trim() || "mcp.invoke",
    port,
    host,
    publicBaseUrl: (
      env.PUBLIC_BASE_URL?.trim() || `http://${host}:${port}`
    ).replace(/\/+$/, ""),
  };
}
