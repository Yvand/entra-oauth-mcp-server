import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { AppConfig } from "./config.js";

/** Identity information we are willing to surface to tools. */
export interface TokenIdentity {
  subject: string;
  objectId?: string;
  tenantId?: string;
  clientId?: string;
  username?: string;
  name?: string;
  scopes: string[];
  issuer: string;
  audience: string;
  issuedAt?: number;
  expiresAt?: number;
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: "invalid_request" | "invalid_token" | "insufficient_scope",
    message: string,
    readonly requiredScope?: string,
  ) {
    super(message);
    this.name = "AuthError";
  }

  /** RFC 6750 `WWW-Authenticate` challenge value. */
  challenge(resourceMetadataUrl?: string): string {
    const parts = [`error="${this.code}"`, `error_description="${this.message}"`];
    if (this.code === "insufficient_scope" && this.requiredScope) {
      parts.push(`scope="${this.requiredScope}"`);
    }
    if (resourceMetadataUrl) {
      parts.push(`resource_metadata="${resourceMetadataUrl}"`);
    }
    return `Bearer ${parts.join(", ")}`;
  }
}

/** Pulls the raw JWT out of an `Authorization: Bearer <token>` header. */
export function extractBearerToken(header: string | undefined): string {
  if (!header) {
    throw new AuthError(401, "invalid_request", "Missing Authorization header.");
  }
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  if (!token) {
    throw new AuthError(
      401,
      "invalid_request",
      "Authorization header must use the Bearer scheme.",
    );
  }
  return token;
}

/** Entra puts delegated scopes in the space-delimited `scp` claim. */
export function parseScopes(payload: JWTPayload): string[] {
  const raw = (payload as { scp?: unknown }).scp;
  if (typeof raw === "string") {
    return raw.split(" ").map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === "string" && s.length > 0);
  }
  return [];
}

export function assertRequiredScope(
  scopes: string[],
  requiredScope: string,
): void {
  if (!scopes.includes(requiredScope)) {
    throw new AuthError(
      403,
      "insufficient_scope",
      `Token is missing the required delegated scope "${requiredScope}".`,
      requiredScope,
    );
  }
}

/** Maps a verified payload onto the small set of claims we expose. */
export function toTokenIdentity(payload: JWTPayload): TokenIdentity {
  const claims = payload as JWTPayload & Record<string, unknown>;
  const audience = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;

  const str = (key: string): string | undefined => {
    const value = claims[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

  const subject = payload.sub ?? str("oid");
  if (!subject) {
    throw new AuthError(
      401,
      "invalid_token",
      "Token does not contain a subject claim.",
    );
  }

  return {
    subject,
    objectId: str("oid"),
    tenantId: str("tid"),
    clientId: str("azp") ?? str("appid"),
    username: str("preferred_username") ?? str("upn"),
    name: str("name"),
    scopes: parseScopes(payload),
    issuer: payload.iss ?? "",
    audience: audience ?? "",
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}

export type JwtVerifier = (token: string) => Promise<JWTPayload>;

/**
 * Builds a verifier backed by the tenant's remote JWKS. Signature, issuer,
 * audience and expiry (`exp`/`nbf`) are all enforced by `jwtVerify`.
 */
export function createEntraVerifier(config: AppConfig): JwtVerifier {
  const jwks = createRemoteJWKSet(new URL(config.jwksUri));
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.audiences,
      algorithms: ["RS256"],
      clockTolerance: 5,
    });
    return payload;
  };
}

/**
 * Full validation pipeline: bearer extraction, JWT verification against Entra,
 * then the delegated-scope check.
 */
export async function authenticate(
  authorizationHeader: string | undefined,
  verify: JwtVerifier,
  requiredScope: string,
): Promise<TokenIdentity> {
  const token = extractBearerToken(authorizationHeader);

  let payload: JWTPayload;
  try {
    payload = await verify(token);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "verification failed";
    throw new AuthError(401, "invalid_token", `Invalid access token: ${reason}`);
  }

  const identity = toTokenIdentity(payload);
  assertRequiredScope(identity.scopes, requiredScope);
  return identity;
}
