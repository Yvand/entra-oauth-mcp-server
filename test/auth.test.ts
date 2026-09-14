import { describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, jwtVerify } from "jose";
import {
  AuthError,
  assertRequiredScope,
  authenticate,
  extractBearerToken,
  parseScopes,
  toTokenIdentity,
} from "../src/auth.js";
import { loadConfig } from "../src/config.js";

const ISSUER = "https://login.microsoftonline.com/tenant-id/v2.0";
const AUDIENCE = "api://client-id";

async function makeTestKit() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "test-key" };
  const jwks = createLocalJWKSet({ keys: [jwk] });

  const sign = async (
    claims: Record<string, unknown>,
    overrides: { issuer?: string; audience?: string; expiresIn?: string } = {},
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(overrides.issuer ?? ISSUER)
      .setAudience(overrides.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(overrides.expiresIn ?? "5m")
      .sign(privateKey);

  const verify = async (token: string) => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ISSUER,
      audience: [AUDIENCE],
      algorithms: ["RS256"],
    });
    return payload;
  };

  return { sign, verify };
}

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed header", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(extractBearerToken("bearer   abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("rejects a missing header", () => {
    expect(() => extractBearerToken(undefined)).toThrowError(AuthError);
  });

  it("rejects a non-bearer scheme or empty token", () => {
    expect(() => extractBearerToken("Basic abc")).toThrowError(/Bearer scheme/);
    expect(() => extractBearerToken("Bearer ")).toThrowError(/Bearer scheme/);
  });
});

describe("parseScopes", () => {
  it("splits the space-delimited scp claim", () => {
    expect(parseScopes({ scp: "mcp.invoke User.Read" })).toEqual([
      "mcp.invoke",
      "User.Read",
    ]);
  });

  it("supports array-valued scp and missing scp", () => {
    expect(parseScopes({ scp: ["mcp.invoke"] as unknown as string })).toEqual([
      "mcp.invoke",
    ]);
    expect(parseScopes({})).toEqual([]);
  });
});

describe("assertRequiredScope", () => {
  it("passes when the scope is present", () => {
    expect(() => assertRequiredScope(["mcp.invoke"], "mcp.invoke")).not.toThrow();
  });

  it("throws 403 insufficient_scope when missing", () => {
    try {
      assertRequiredScope(["User.Read"], "mcp.invoke");
      expect.unreachable();
    } catch (error) {
      const authError = error as AuthError;
      expect(authError.status).toBe(403);
      expect(authError.code).toBe("insufficient_scope");
      expect(authError.challenge()).toContain('scope="mcp.invoke"');
    }
  });
});

describe("toTokenIdentity", () => {
  it("maps only safe claims and drops everything else", () => {
    const identity = toTokenIdentity({
      sub: "sub-1",
      oid: "oid-1",
      tid: "tenant-id",
      azp: "client-id",
      preferred_username: "user@contoso.com",
      name: "Test User",
      scp: "mcp.invoke",
      iss: ISSUER,
      aud: AUDIENCE,
      iat: 1,
      exp: 2,
      groups: ["secret-group"],
    } as never);

    expect(identity).toEqual({
      subject: "sub-1",
      objectId: "oid-1",
      tenantId: "tenant-id",
      clientId: "client-id",
      username: "user@contoso.com",
      name: "Test User",
      scopes: ["mcp.invoke"],
      issuer: ISSUER,
      audience: AUDIENCE,
      issuedAt: 1,
      expiresAt: 2,
    });
    expect(JSON.stringify(identity)).not.toContain("secret-group");
  });

  it("throws when no subject claim is present", () => {
    expect(() => toTokenIdentity({ iss: ISSUER, aud: AUDIENCE })).toThrowError(
      /subject claim/,
    );
  });
});

describe("authenticate", () => {
  it("accepts a valid token carrying the required scope", async () => {
    const { sign, verify } = await makeTestKit();
    const token = await sign({ sub: "sub-1", oid: "oid-1", scp: "mcp.invoke" });

    const identity = await authenticate(`Bearer ${token}`, verify, "mcp.invoke");
    expect(identity.subject).toBe("sub-1");
    expect(identity.scopes).toContain("mcp.invoke");
  });

  it("rejects an expired token", async () => {
    const { sign, verify } = await makeTestKit();
    const token = await sign({ sub: "sub-1", scp: "mcp.invoke" }, { expiresIn: "-1m" });

    await expect(
      authenticate(`Bearer ${token}`, verify, "mcp.invoke"),
    ).rejects.toThrowError(/Invalid access token/);
  });

  it("rejects a token from the wrong issuer", async () => {
    const { sign, verify } = await makeTestKit();
    const token = await sign(
      { sub: "sub-1", scp: "mcp.invoke" },
      { issuer: "https://evil.example.com/v2.0" },
    );

    await expect(
      authenticate(`Bearer ${token}`, verify, "mcp.invoke"),
    ).rejects.toThrowError(/Invalid access token/);
  });

  it("rejects a token for the wrong audience", async () => {
    const { sign, verify } = await makeTestKit();
    const token = await sign(
      { sub: "sub-1", scp: "mcp.invoke" },
      { audience: "api://other-api" },
    );

    await expect(
      authenticate(`Bearer ${token}`, verify, "mcp.invoke"),
    ).rejects.toThrowError(/Invalid access token/);
  });

  it("rejects a token signed by an untrusted key", async () => {
    const kitA = await makeTestKit();
    const kitB = await makeTestKit();
    const token = await kitB.sign({ sub: "sub-1", scp: "mcp.invoke" });

    await expect(
      authenticate(`Bearer ${token}`, kitA.verify, "mcp.invoke"),
    ).rejects.toThrowError(/Invalid access token/);
  });

  it("rejects a valid token that lacks the required scope", async () => {
    const { sign, verify } = await makeTestKit();
    const token = await sign({ sub: "sub-1", scp: "User.Read" });

    await expect(
      authenticate(`Bearer ${token}`, verify, "mcp.invoke"),
    ).rejects.toThrowError(/missing the required delegated scope/);
  });
});

describe("loadConfig", () => {
  const base = {
    ENTRA_TENANT_ID: "tenant-id",
    ENTRA_AUDIENCE: "api://client-id",
  } as NodeJS.ProcessEnv;

  it("derives issuer and JWKS URI from the tenant id", () => {
    const config = loadConfig({ ...base });
    expect(config.issuer).toBe(ISSUER);
    expect(config.jwksUri).toBe(
      "https://login.microsoftonline.com/tenant-id/discovery/v2.0/keys",
    );
    expect(config.requiredScope).toBe("mcp.invoke");
    expect(config.publicBaseUrl).toBe("http://127.0.0.1:3000");
  });

  it("supports multiple audiences and overrides", () => {
    const config = loadConfig({
      ...base,
      ENTRA_AUDIENCE: "api://client-id, client-id",
      MCP_REQUIRED_SCOPE: "custom.scope",
      PUBLIC_BASE_URL: "https://mcp.example.com/",
    });
    expect(config.audiences).toEqual(["api://client-id", "client-id"]);
    expect(config.requiredScope).toBe("custom.scope");
    expect(config.publicBaseUrl).toBe("https://mcp.example.com");
  });

  it("fails fast when required variables are missing", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrowError(
      /ENTRA_TENANT_ID/,
    );
  });
});
