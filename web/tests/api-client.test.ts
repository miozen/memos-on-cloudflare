import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authStateMocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  isTokenExpired: vi.fn(),
  setAccessToken: vi.fn(),
  shouldAttemptTokenRefresh: vi.fn(),
}));

const redirectMocks = vi.hoisted(() => ({
  redirectOnAuthFailure: vi.fn(),
}));

vi.mock("@/auth-state", () => ({
  getAccessToken: authStateMocks.getAccessToken,
  isTokenExpired: authStateMocks.isTokenExpired,
  REQUEST_TOKEN_EXPIRY_BUFFER_MS: 30_000,
  setAccessToken: authStateMocks.setAccessToken,
  shouldAttemptTokenRefresh: authStateMocks.shouldAttemptTokenRefresh,
}));

vi.mock("@/i18n", () => ({
  default: {
    t: (key: string) => key,
  },
}));

vi.mock("@/utils/auth-redirect", () => ({
  redirectOnAuthFailure: redirectMocks.redirectOnAuthFailure,
}));

import { apiRequest, shouldSkipAuthRefreshRetry } from "@/api/client";

describe("api/client 401 refresh exemption", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    authStateMocks.getAccessToken.mockReturnValue("existing-token");
    authStateMocks.isTokenExpired.mockReturnValue(false);
    authStateMocks.shouldAttemptTokenRefresh.mockReturnValue(false);
    authStateMocks.setAccessToken.mockReset();
    redirectMocks.redirectOnAuthFailure.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("identifies auth endpoints exempt from 401 refresh retry", () => {
    expect(shouldSkipAuthRefreshRetry("/api/v1/auth/signin")).toBe(true);
    expect(shouldSkipAuthRefreshRetry("/api/v1/auth/signup")).toBe(true);
    expect(shouldSkipAuthRefreshRetry("/api/v1/auth/refresh")).toBe(true);
    expect(shouldSkipAuthRefreshRetry("/api/v1/auth/signout")).toBe(true);
    expect(shouldSkipAuthRefreshRetry("/api/v1/auth/signin?foo=1")).toBe(true);
    expect(shouldSkipAuthRefreshRetry("/api/v1/auth/me")).toBe(false);
    expect(shouldSkipAuthRefreshRetry("/api/v1/memos")).toBe(false);
  });

  it("does not refresh or redirect on 401 from /api/v1/auth/signin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Invalid credentials" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(apiRequest("POST", "/api/v1/auth/signin", { username: "alice", password: "wrong" })).rejects.toThrow(
      "Invalid credentials",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/auth/signin");
    expect(redirectMocks.redirectOnAuthFailure).not.toHaveBeenCalled();
  });

  it("refreshes and replays protected API requests on 401", async () => {
    let currentToken = "stale-token";
    authStateMocks.getAccessToken.mockImplementation(() => currentToken);
    authStateMocks.setAccessToken.mockImplementation((token: string) => {
      currentToken = token;
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "token expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: "fresh-token", expiresAt: Math.floor(Date.now() / 1000) + 900 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ memos: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiRequest<{ memos: unknown[] }>("GET", "/api/v1/memos");
    expect(result).toEqual({ memos: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/auth/refresh");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/memos");
    expect(redirectMocks.redirectOnAuthFailure).not.toHaveBeenCalled();
  });
});
