import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import app from "../src/index.ts";
import { createAccessToken } from "../src/auth/jwt.ts";
import { extractMemoTags, replaceMemoTagInContent } from "../src/tags.ts";

const secret = "local-pkm-enhancements-test-secret";
let sqlite;
let cacheStore;
let env;
let tokens;

function createMockDb(db) {
  return {
    prepare(sql) {
      const prepare = (parameters = []) => ({
        bind: (...values) => prepare(values),
        first: async () => db.prepare(sql).get(...parameters) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...parameters) }),
        run: async () => db.prepare(sql).run(...parameters),
      });
      return prepare();
    },
  };
}

function createMockKv(store) {
  return {
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

function request(path, options = {}) {
  return app.request(`https://memos.test${path}`, options, env);
}

function asUser(username, body) {
  return {
    headers: { Authorization: `Bearer ${tokens[username]}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  for (const name of ["0001_initial.sql", "0002_webhooks.sql", "0003_performance_indexes.sql"]) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  }
  cacheStore = new Map();
  env = {
    DB: createMockDb(sqlite),
    CACHE: createMockKv(cacheStore),
    JWT_SECRET: secret,
    INSTANCE_NAME: "pkm-enhancements-test",
  };

  sqlite.exec(`
    INSERT INTO user (id, username, password_hash, role, email) VALUES
      (1, 'alice', 'unused', 'ADMIN', 'alice@example.com'),
      (2, 'bob', 'unused', 'USER', 'bob@example.com');
  `);

  tokens = {
    alice: (await createAccessToken({ id: 1, username: "alice", role: "ADMIN", status: "NORMAL" }, secret)).token,
    bob: (await createAccessToken({ id: 2, username: "bob", role: "USER", status: "NORMAL" }, secret)).token,
  };
});

afterEach(() => {
  sqlite.close();
});

test("extractMemoTags skips code blocks, inline code, URL fragments, hex colors, and deduplicates", () => {
  const content = [
    "#日常 记录今天 #日常 的开发",
    "颜色 #0080ff 与 #fff 不是标签，路由 #/pos 和 #/guest 以及 #项目/ 尾斜杠和 #--- 也不是标签",
    "链接 http://localhost:1520/#/pos 与 https://example.com/docs#section-1 与 [锚点](https://a.com#top) 也不是标签",
    "行内代码 `#define` 不是标签，但 #技术 和 #项目/一期 是标签",
    "```c",
    "#include <stdio.h>",
    "#未生效代码块标签",
    "```",
  ].join("\n");

  assert.deepEqual(extractMemoTags(content), ["日常", "技术", "项目/一期"]);

  const replaced = replaceMemoTagInContent(content, "日常", "生活");
  assert.ok(replaced.includes("#生活 记录今天 #生活 的开发"));
  assert.ok(replaced.includes("https://example.com/docs#section-1"));
  assert.ok(replaced.includes("`#define`"));
  assert.ok(replaced.includes("#include <stdio.h>"));

  const removed = replaceMemoTagInContent("#日常 买菜 #技术", "日常", null);
  assert.equal(removed, "买菜 #技术");
});

test("POST /api/v1/memos/tags:rename safely renames and removes tags only for the caller and invalidates stats cache", async () => {
  await request("/api/v1/memos", {
    method: "POST",
    ...asUser("alice", { content: "#旧标签 测试内容\n`#旧标签`\nhttps://a.com#旧标签", visibility: "PRIVATE" }),
  });
  await request("/api/v1/memos", {
    method: "POST",
    ...asUser("alice", { content: "第二条 #旧标签/子类 不应误改，仅改 #旧标签", visibility: "PRIVATE" }),
  });
  await request("/api/v1/memos", {
    method: "POST",
    ...asUser("bob", { content: "#旧标签 别人的笔记不得修改", visibility: "PRIVATE" }),
  });

  // Prime owner stats cache
  const statsBeforeRes = await request("/api/v1/users/alice/stats", asUser("alice"));
  assert.equal(statsBeforeRes.status, 200);
  const statsBefore = await statsBeforeRes.json();
  assert.equal(statsBefore.tagCount["旧标签"], 2);
  assert.ok(cacheStore.has("cfmemos:v1:user:stats:alice:owner"));

  const renameRes = await request("/api/v1/memos/tags:rename", {
    method: "POST",
    ...asUser("alice", { oldTag: "旧标签", newTag: "资料" }),
  });
  assert.equal(renameRes.status, 200);
  const renameBody = await renameRes.json();
  assert.equal(renameBody.updatedCount, 2);

  // Cache should be invalidated and rebuilt with updated tag stats.
  const statsAfterRes = await request("/api/v1/users/alice/stats", asUser("alice"));
  const statsAfter = await statsAfterRes.json();
  assert.equal(statsAfter.tagCount["旧标签"], undefined);
  assert.equal(statsAfter.tagCount["资料"], 2);
  assert.equal(statsAfter.tagCount["旧标签/子类"], 1);

  // Bob's memo must remain untouched.
  const bobMemos = await (await request("/api/v1/memos", asUser("bob"))).json();
  assert.deepEqual(bobMemos.memos[0].tags, ["旧标签"]);

  // Verify code block and URL were preserved untouched.
  const aliceMemos = await (await request("/api/v1/memos", asUser("alice"))).json();
  const firstMemo = aliceMemos.memos.find((m) => m.content.includes("测试内容"));
  assert.ok(firstMemo.content.includes("#资料 测试内容"));
  assert.ok(firstMemo.content.includes("`#旧标签`"));
  assert.ok(firstMemo.content.includes("https://a.com#旧标签"));

  // Leaving newTag null removes the tag from memos cleanly.
  const removeRes = await request("/api/v1/memos/tags:rename", {
    method: "POST",
    ...asUser("alice", { oldTag: "资料", newTag: null }),
  });
  assert.equal((await removeRes.json()).updatedCount, 2);
  const finalStats = await (await request("/api/v1/users/alice/stats", asUser("alice"))).json();
  assert.equal(finalStats.tagCount["资料"], undefined);
});

test("GET /api/v1/memos/export downloads only caller memos in JSON and Markdown formats", async () => {
  await request("/api/v1/memos", {
    method: "POST",
    ...asUser("alice", { content: "#技术 导出的第一条笔记", visibility: "PRIVATE" }),
  });
  await request("/api/v1/memos", {
    method: "POST",
    ...asUser("bob", { content: "#秘密 Bob的笔记", visibility: "PRIVATE" }),
  });

  const jsonRes = await request("/api/v1/memos/export?format=json", asUser("alice"));
  assert.equal(jsonRes.status, 200);
  assert.ok((jsonRes.headers.get("Content-Disposition") || "").includes(".json"));
  const exported = await jsonRes.json();
  assert.equal(exported.user, "alice");
  assert.equal(exported.memoCount, 1);
  assert.equal(exported.memos[0].content, "#技术 导出的第一条笔记");

  const mdRes = await request("/api/v1/memos/export?format=markdown", asUser("alice"));
  assert.equal(mdRes.status, 200);
  assert.ok((mdRes.headers.get("Content-Disposition") || "").includes(".md"));
  const mdText = await mdRes.text();
  assert.ok(mdText.includes("#技术 导出的第一条笔记"));
  assert.equal(mdText.includes("Bob的笔记"), false);
});

test("POST /api/v1/ai/suggestTags uses Workers AI when available and falls back cleanly to heuristics", async () => {
  // Without AI binding -> heuristic match
  const heuristicRes = await request("/api/v1/ai/suggestTags", {
    method: "POST",
    ...asUser("alice", {
      content: "今天修复了 Cloudflare Workers 数据库 SQL 性能问题，准备上线项目",
      candidateTags: ["日常", "技术", "项目", "旅行"],
    }),
  });
  assert.equal(heuristicRes.status, 200);
  const heuristicBody = await heuristicRes.json();
  assert.equal(heuristicBody.source, "heuristic");
  assert.ok(heuristicBody.tags.includes("技术"));

  // With mock AI binding -> AI JSON response
  env.AI = {
    async run() {
      return { response: '["旅行","日常"]' };
    },
  };
  const aiRes = await request("/api/v1/ai/suggestTags", {
    method: "POST",
    ...asUser("alice", {
      content: "#日常 预订了下周去云南的自驾机票和酒店",
      candidateTags: ["日常", "旅行", "工作"],
    }),
  });
  assert.equal(aiRes.status, 200);
  const aiBody = await aiRes.json();
  assert.equal(aiBody.source, "ai");
  // "日常" is already in content so it must not be suggested again
  assert.deepEqual(aiBody.tags, ["旅行"]);
});
