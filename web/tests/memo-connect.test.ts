import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { State } from "@/types/proto/api/v1/common_pb";
import { Visibility } from "@/types/proto/api/v1/memo_service_pb";

const fetchMock = vi.fn();

vi.mock("@/auth-state", () => ({
  REQUEST_TOKEN_EXPIRY_BUFFER_MS: 30_000,
  clearAccessToken: vi.fn(),
  getAccessToken: vi.fn(() => null),
  hasStoredToken: vi.fn(() => false),
  shouldAttemptTokenRefresh: vi.fn(() => false),
  isTokenExpired: vi.fn(() => false),
  setAccessToken: vi.fn(),
}));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("memoServiceClient", () => {
  it("keeps archived memos archived when the worker returns state", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          memos: [
            {
              name: "memos/archived",
              state: "ARCHIVED",
              creator: "users/demo",
              createTime: "2026-05-31T00:00:00.000Z",
              updateTime: "2026-05-31T00:00:00.000Z",
              visibility: "PRIVATE",
              content: "archived memo",
            },
          ],
          nextPageToken: "",
          totalSize: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { memoServiceClient } = await import("@/connect");
    const response = await memoServiceClient.listMemos({ state: State.ARCHIVED });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("state=ARCHIVED"), expect.any(Object));
    expect(response.memos[0].state).toBe(State.ARCHIVED);
  });

  it("normalizes createMemo responses to match the protobuf Memo shape", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name: "memos/created1",
          state: "NORMAL",
          creator: "users/demo",
          createTime: "2026-06-01T00:00:00.000Z",
          updateTime: "2026-06-01T00:00:00.000Z",
          visibility: "PUBLIC",
          content: "hello",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { memoServiceClient } = await import("@/connect");
    const created = await memoServiceClient.createMemo({
      memo: { content: "hello", visibility: Visibility.PUBLIC },
    });

    expect(created.state).toBe(State.NORMAL);
    expect(created.visibility).toBe(Visibility.PUBLIC);
    expect(created.createTime).toEqual({ seconds: Math.floor(Date.parse("2026-06-01T00:00:00.000Z") / 1000), nanos: 0 });
  });
});
