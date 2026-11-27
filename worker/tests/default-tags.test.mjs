import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import app from "../src/index.ts";
import { createAccessToken } from "../src/auth/jwt.ts";
import {
  DEFAULT_TAGS_APPLIED_SETTING_NAME,
  DEFAULT_TAGS_SETTING_NAME,
  ensureDefaultTagsSetting,
} from "../src/default-tags.ts";

const secret = "local-default-tags-test-secret";
let sqlite;
let cacheStore;
let env;

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

function rgbToHex(color) {
  const toHex = (value) =>
    Math.round(Math.min(Math.max(value ?? 0, 0), 1) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(color?.red)}${toHex(color?.green)}${toHex(color?.blue)}`;
}

function request(path, options = {}) {
  return app.request(`https://memos.test${path}`, options, env);
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  for (const name of ["0001_initial.sql", "0002_webhooks.sql", "0003_performance_indexes.sql"]) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  }
  cacheStore = new Map();
  env = {
    DB: createMockDb(sqlite),
    CACHE: createMockKv(cacheStore),
    JWT_SECRET: secret,
    INSTANCE_NAME: "default-tags-test",
  };
});

afterEach(() => {
  sqlite.close();
});

test("fresh instance initializes 4 default color rules on first signup without creating fake memos", async () => {
  const signupRes = await request("/api/v1/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "password123" }),
  });
  assert.equal(signupRes.status, 200);
  const { accessToken } = await signupRes.json();

  const memoCountRow = sqlite.prepare("SELECT COUNT(*) AS count FROM memo").get();
  assert.equal(memoCountRow.count, 0);

  const settingRes = await request("/api/v1/instance/settings/TAGS", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(settingRes.status, 200);
  const settingBody = await settingRes.json();
  assert.equal(settingBody.name, DEFAULT_TAGS_SETTING_NAME);

  const parsed = JSON.parse(settingBody.value);
  const patterns = Object.keys(parsed.tags);
  assert.deepEqual(patterns, [
    "^(日常|灵感|资料)$",
    "^(待办)$",
    "^(技术|项目|工作|财务)$",
    "^(家族|家庭|健康|旅行)$",
  ]);
  for (const pattern of patterns) {
    assert.equal(pattern.includes("\\|"), false);
    assert.equal(parsed.tags[pattern].blurContent, false);
  }
  assert.equal(rgbToHex(parsed.tags["^(日常|灵感|资料)$"].backgroundColor), "#0080ff");
  assert.equal(rgbToHex(parsed.tags["^(待办)$"].backgroundColor), "#ff8000");
  assert.equal(rgbToHex(parsed.tags["^(技术|项目|工作|财务)$"].backgroundColor), "#00cc66");
  assert.equal(rgbToHex(parsed.tags["^(家族|家庭|健康|旅行)$"].backgroundColor), "#8b5cf6");

  // Internal initialization marker is hidden from settings list and direct access.
  const listRes = await request("/api/v1/instance/settings", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.equal(listBody.settings.some((s) => s.name.includes("default_tags_v1_applied")), false);

  const hiddenGetRes = await request(`/api/v1/instance/settings/${DEFAULT_TAGS_APPLIED_SETTING_NAME}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(hiddenGetRes.status, 404);
});

test("POST /api/v1/users initializes default rules for first admin and keeps initialization idempotent", async () => {
  const createRes = await request("/api/v1/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "firstadmin", password: "password123" }),
  });
  assert.equal(createRes.status, 201);

  assert.equal(await ensureDefaultTagsSetting(env.DB, env.CACHE), false);
  assert.equal(await ensureDefaultTagsSetting(env.DB, env.CACHE), false);

  const tagsRow = sqlite.prepare("SELECT value FROM system_setting WHERE name = ?").get(DEFAULT_TAGS_SETTING_NAME);
  assert.ok(tagsRow);
  const parsed = JSON.parse(tagsRow.value);
  assert.equal(Object.keys(parsed.tags).length, 4);

  // Admin edits or deletes a rule later; restarts/re-checks must never overwrite their changes.
  const adminToken = (await createAccessToken({ id: 1, username: "firstadmin", role: "ADMIN", status: "NORMAL" }, secret)).token;
  delete parsed.tags["^(待办)$"];
  parsed.tags["^(日常|灵感|资料)$"].backgroundColor = { red: 1, green: 0, blue: 0 };

  const patchRes = await request("/api/v1/instance/settings/TAGS", {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ value: JSON.stringify(parsed) }),
  });
  assert.equal(patchRes.status, 200);

  assert.equal(await ensureDefaultTagsSetting(env.DB, env.CACHE), false);

  const afterGetRes = await request("/api/v1/instance/settings/TAGS", {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(afterGetRes.status, 200);
  const afterParsed = JSON.parse((await afterGetRes.json()).value);
  assert.equal(Object.keys(afterParsed.tags).length, 3);
  assert.equal("^(待办)$" in afterParsed.tags, false);
  assert.equal(rgbToHex(afterParsed.tags["^(日常|灵感|资料)$"].backgroundColor), "#ff0000");
});

test("existing instance preserves custom rules, legacy memos, users, and repairs legacy escaped-pipe rules", async () => {
  sqlite.exec(`
    INSERT INTO user (id, username, password_hash, role, email) VALUES
      (1, 'admin', 'unused', 'ADMIN', 'admin@example.com'),
      (2, 'member', 'unused', 'USER', 'member@example.com');
    INSERT INTO memo (id, uid, creator_id, content, visibility, payload, created_ts, updated_ts) VALUES
      (1, 'memo-existing', 2, '#项目 已有历史笔记内容', 'PRIVATE', '{"tags":["项目"],"property":{}}', 1700000000, 1700000000);
    INSERT INTO system_setting (name, value) VALUES
      ('instance/settings/TAGS', '${JSON.stringify({
        tags: {
          "secret/.*": { backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 }, blurContent: true },
          日常: { backgroundColor: { red: 1, green: 0.2, blue: 0.4 }, blurContent: false },
          "^(日常\\|灵感\\|资料)$": { backgroundColor: { red: 0, green: 0, blue: 1 }, blurContent: false },
        },
      })}');
  `);

  // Simulate stale KV cache from before upgrade.
  await env.CACHE.put(`cfmemos:v1:instance:setting:${DEFAULT_TAGS_SETTING_NAME}`, JSON.stringify({
    name: DEFAULT_TAGS_SETTING_NAME,
    value: JSON.stringify({ tags: { "secret/.*": { blurContent: true } } }),
  }));

  const adminToken = (await createAccessToken({ id: 1, username: "admin", role: "ADMIN", status: "NORMAL" }, secret)).token;
  const res = await request("/api/v1/instance/settings/TAGS", {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const parsed = JSON.parse(body.value);

  // User custom rules and explicit single-tag custom rule are untouched.
  assert.deepEqual(parsed.tags["secret/.*"], { backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 }, blurContent: true });
  assert.deepEqual(parsed.tags["日常"], { backgroundColor: { red: 1, green: 0.2, blue: 0.4 }, blurContent: false });
  // Broken legacy escaped-pipe rule was replaced cleanly by canonical defaults.
  assert.equal("^(日常\\|灵感\\|资料)$" in parsed.tags, false);
  assert.equal(rgbToHex(parsed.tags["^(日常|灵感|资料)$"].backgroundColor), "#0080ff");
  assert.equal(rgbToHex(parsed.tags["^(待办)$"].backgroundColor), "#ff8000");
  assert.equal(rgbToHex(parsed.tags["^(技术|项目|工作|财务)$"].backgroundColor), "#00cc66");
  assert.equal(rgbToHex(parsed.tags["^(家族|家庭|健康|旅行)$"].backgroundColor), "#8b5cf6");

  // Existing users and memos remain completely intact.
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM user").get().count, 2);
  const existingMemo = sqlite.prepare("SELECT content, payload FROM memo WHERE uid = 'memo-existing'").get();
  assert.equal(existingMemo.content, "#项目 已有历史笔记内容");
  assert.deepEqual(JSON.parse(existingMemo.payload).tags, ["项目"]);
});

test("memo creation, Chinese tag extraction, user tag stats, and tag filtering work normally", async () => {
  sqlite.exec(`
    INSERT INTO user (id, username, password_hash, role, email) VALUES
      (1, 'admin', 'unused', 'ADMIN', 'admin@example.com');
  `);
  const adminToken = (await createAccessToken({ id: 1, username: "admin", role: "ADMIN", status: "NORMAL" }, secret)).token;

  const createRes = await request("/api/v1/memos", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: "#技术 #日常 完成 Cloudflare 部署检查\n正文包含待办关键词但未加井号",
      visibility: "PRIVATE",
    }),
  });
  assert.equal(createRes.status, 201);
  const createdMemo = await createRes.json();
  assert.deepEqual(createdMemo.tags, ["技术", "日常"]);

  const statsRes = await request("/api/v1/users/admin/stats", {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(statsRes.status, 200);
  const stats = await statsRes.json();
  assert.deepEqual(stats.tagCount, { 技术: 1, 日常: 1 });

  const filterTechRes = await request(`/api/v1/memos?filter=${encodeURIComponent('tag in ["技术"]')}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(filterTechRes.status, 200);
  const filterTechBody = await filterTechRes.json();
  assert.equal(filterTechBody.memos.length, 1);
  assert.equal(filterTechBody.memos[0].uid, createdMemo.uid);

  const filterTodoRes = await request(`/api/v1/memos?filter=${encodeURIComponent('tag in ["待办"]')}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(filterTodoRes.status, 200);
  const filterTodoBody = await filterTodoRes.json();
  assert.equal(filterTodoBody.memos.length, 0);
});
