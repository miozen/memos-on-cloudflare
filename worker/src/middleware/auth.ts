import { createMiddleware } from "hono/factory";
import type { Env, UserPayload } from "../types";
import { verifyAccessToken } from "../auth/jwt";
import { hashPAT } from "../auth/pat";
import { findActiveUserPayload } from "../auth/user";

type AuthEnv = {
  Bindings: Env;
  Variables: { user: UserPayload };
};

type PATLookupResult = {
  user_id: number;
  username: string;
  role: string;
  row_status: string;
};

export function extractAuthToken(headers: {
  header: (name: string) => string | undefined;
}): string | undefined {
  const authHeader = headers.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  const xApiKey = headers.header("X-API-Key");
  if (xApiKey) {
    return xApiKey;
  }

  const memosAccessToken = headers.header("Memos-Access-Token");
  if (memosAccessToken) {
    return memosAccessToken;
  }

  const token = headers.header("Token");
  if (token) {
    return token;
  }

  return undefined;
}

async function findUserByPATHash(db: D1Database, tokenHash: string): Promise<PATLookupResult | null> {
  const { results } = await db.prepare(
    `SELECT us.user_id, us.value, u.username, u.role, u.row_status
     FROM user_setting us
     JOIN user u ON u.id = us.user_id
     WHERE us.key = 'personal_access_tokens'`
  ).all<{
    user_id: number;
    value: string;
    username: string;
    role: string;
    row_status: string;
  }>();

  for (const row of results || []) {
    try {
      if (row.row_status !== "NORMAL") {
        continue;
      }

      const tokens = JSON.parse(row.value || "[]") as Array<{ hash?: string; expiresAt?: string | null }>;
      const matchedToken = tokens.find((token) => token.hash === tokenHash);
      if (matchedToken) {
        if (matchedToken.expiresAt) {
          const expiresAt = Date.parse(matchedToken.expiresAt);
          if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            continue;
          }
        }

        return {
          user_id: row.user_id,
          username: row.username,
          role: row.role,
          row_status: row.row_status,
        };
      }
    } catch {
      // Ignore malformed PAT payloads and continue scanning.
    }
  }

  return null;
}

export const authRequired = createMiddleware<AuthEnv>(async (c, next) => {
  const token = extractAuthToken(c.req);

  if (!token) {
    return c.json({ code: 16, message: "user not found", details: [] }, 401);
  }

  const user = await resolveAuthUser(c.env.DB, c.env.JWT_SECRET, c.req);
  if (!user) {
    const message = token.startsWith("memos_pat_") ? "invalid access token" : "token has expired or user not found";
    return c.json({ code: 16, message, details: [] }, 401);
  }

  c.set("user", user);
  return next();
});

export async function resolveAuthUser(
  db: D1Database,
  jwtSecret: string,
  headers: { header: (name: string) => string | undefined },
): Promise<UserPayload | undefined> {
  const token = extractAuthToken(headers);
  if (!token) {
    return undefined;
  }

  if (token.startsWith("memos_pat_")) {
    const hash = await hashPAT(token);
    const result = await findUserByPATHash(db, hash);
    if (!result) {
      return undefined;
    }
    return {
      id: result.user_id,
      username: result.username,
      role: result.role,
      status: result.row_status,
    };
  }

  let claims: Awaited<ReturnType<typeof verifyAccessToken>> | undefined;
  try {
    claims = await verifyAccessToken(token, jwtSecret);
  } catch {
    return undefined;
  }

  return findActiveUserPayload(db, claims.sub);
}

export const authOptional = createMiddleware<AuthEnv>(async (c, next) => {
  const user = await resolveAuthUser(c.env.DB, c.env.JWT_SECRET, c.req);
  if (user) {
    c.set("user", user);
  }

  return next();
});
