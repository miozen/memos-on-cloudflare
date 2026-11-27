import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import app from "../src/index.ts";
import { createAccessToken } from "../src/auth/jwt.ts";
import { hashPAT } from "../src/auth/pat.ts";

const secret = "local-api-fixes-test-secret";
let sqlite;
let env;
let tokens;
let objects;
let failNextAttachmentInsert = false;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  for (const name of ["0001_initial.sql", "0002_webhooks.sql", "0003_performance_indexes.sql"]) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  }
  failNextAttachmentInsert = false;

  const DB = {
    prepare(sql) {
      const prepare = (parameters = []) => ({
        bind: (...values) => prepare(values),
        first: async () => {
          if (failNextAttachmentInsert && sql.includes("INSERT INTO attachment")) {
            failNextAttachmentInsert = false;
            throw new Error("Simulated D1 insert failure");
          }
          return sqlite.prepare(sql).get(...parameters) ?? null;
        },
        all: async () => ({ results: sqlite.prepare(sql).all(...parameters) }),
        run: async () => sqlite.prepare(sql).run(...parameters),
      });
      return prepare();
    },
  };

  objects = new Map();
  const BUCKET = {
    async put(key, body) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, bytes);
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return { body: object, size: object.length };
    },
    async delete(key) {
      objects.delete(key);
    },
  };

  env = { DB, BUCKET, JWT_SECRET: secret, INSTANCE_NAME: "api-fixes-test" };

  sqlite.exec(`
    INSERT INTO user (id, username, password_hash, role, email) VALUES
      (1, 'admin', 'unused', 'ADMIN', 'admin@example.com'),
      (2, 'alice', 'unused', 'USER', 'alice@example.com'),
      (3, 'bob', 'unused', 'USER', 'bob@example.com'),
      (4, 'charlie', 'unused', 'USER', '');
  `);

  tokens = {};
  for (const [id, username, role] of [[1, "admin", "ADMIN"], [2, "alice", "USER"], [3, "bob", "USER"]]) {
    const access = await createAccessToken({ id, username, role, status: "NORMAL" }, secret);
    tokens[username] = access.token;
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  sqlite.close();
});

function request(path, options = {}) {
  return app.request(`https://memos.test${path}`, options, env);
}

function asUser(username, body) {
  return {
    headers: { Authorization: `Bearer ${tokens[username]}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

test("rejects invalid memo visibility, rowStatus, and timestamps with 400 and handles malformed pageToken", async () => {
  assert.equal((await request("/api/v1/memos", { method: "POST", ...asUser("alice", { content: "hi", visibility: "BAD" }) })).status, 400);
  assert.equal((await request("/api/v1/memos", { method: "POST", ...asUser("alice", { content: "hi", createTime: "not-a-date" }) })).status, 400);

  const created = await request("/api/v1/memos", { method: "POST", ...asUser("alice", { content: "ok", visibility: "PUBLIC" }) });
  assert.equal(created.status, 201);
  const memo = await created.json();
  const memoUid = memo.name.replace("memos/", "");

  assert.equal((await request(`/api/v1/memos/${memoUid}`, { method: "PATCH", ...asUser("alice", { rowStatus: "BOGUS" }) })).status, 400);
  assert.equal((await request(`/api/v1/memos/${memoUid}`, { method: "PATCH", ...asUser("alice", { visibility: "BOGUS" }) })).status, 400);

  const malformedList = await request(`/api/v1/memos?pageToken=${btoa("not-a-number")}`);
  assert.equal(malformedList.status, 200);
  const listData = await malformedList.json();
  assert.equal(listData.memos.length, 1);

  sqlite.exec(`INSERT INTO system_setting (name, value) VALUES ('instance/settings/MEMO_RELATED', '{"contentLengthLimit":5}')`);
  const tooLongComment = await request(`/api/v1/memos/${memoUid}/comments`, {
    method: "POST",
    ...asUser("bob", { content: "longer than 5 bytes" }),
  });
  assert.equal(tooLongComment.status, 400);
});

test("deletes memo along with descendant comments, relations, reactions, and R2 attachments", async () => {
  const form = new FormData();
  form.append("file", new File(["parent-data"], "parent.txt", { type: "text/plain" }));
  const parentUpload = await request("/api/v1/attachments", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokens.alice}` },
    body: form,
  });
  assert.equal(parentUpload.status, 201);
  const parentAtt = await parentUpload.json();

  const createMemoRes = await request("/api/v1/memos", {
    method: "POST",
    ...asUser("alice", { content: "parent memo", visibility: "PUBLIC", attachments: [parentAtt.name] }),
  });
  assert.equal(createMemoRes.status, 201);
  const parentMemo = await createMemoRes.json();
  const parentUid = parentMemo.name.replace("memos/", "");

  const commentForm = new FormData();
  commentForm.append("file", new File(["comment-data"], "comment.txt", { type: "text/plain" }));
  const commentUpload = await request("/api/v1/attachments", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokens.bob}` },
    body: commentForm,
  });
  const commentAtt = await commentUpload.json();

  const commentRes = await request(`/api/v1/memos/${parentUid}/comments`, {
    method: "POST",
    ...asUser("bob", { content: "reply", attachments: [commentAtt.name] }),
  });
  assert.equal(commentRes.status, 201);

  await request(`/api/v1/memos/${parentUid}/reactions`, {
    method: "POST",
    ...asUser("bob", { reactionType: "👍" }),
  });
  await request(`/api/v1/memos/${parentUid}/shares`, { method: "POST", ...asUser("alice", {}) });

  assert.equal(objects.size, 2);

  const deleteRes = await request(`/api/v1/memos/${parentUid}`, { method: "DELETE", ...asUser("alice") });
  assert.equal(deleteRes.status, 200);

  assert.equal(sqlite.prepare("SELECT COUNT(*) AS c FROM memo").get().c, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS c FROM memo_relation").get().c, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS c FROM reaction").get().c, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS c FROM attachment").get().c, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS c FROM memo_share").get().c, 0);
  assert.equal(objects.size, 0);
});

test("rolls back R2 object when attachment metadata D1 insert fails", async () => {
  failNextAttachmentInsert = true;
  const form = new FormData();
  form.append("file", new File(["hello stream"], "stream.txt", { type: "text/plain" }));
  const response = await request("/api/v1/attachments", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokens.alice}` },
    body: form,
  });
  assert.equal(response.status, 500);
  assert.equal(objects.size, 0);
});

test("validates user creation/updates and cleans up owned records when deleting user", async () => {
  sqlite.exec(`INSERT INTO system_setting (name, value) VALUES ('instance/settings/GENERAL', '{"disallowUserRegistration":true}');`);

  const pat = "memos_pat_admin_test_token_12345";
  const patHash = await hashPAT(pat);
  sqlite.prepare("INSERT INTO user_setting (user_id, key, value) VALUES (?, 'personal_access_tokens', ?)")
    .run(1, JSON.stringify([{ hash: patHash, description: "ci", expiresAt: null }]));

  const shortPass = await request("/api/v1/users", {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dave", password: "123", role: "ADMIN" }),
  });
  assert.equal(shortPass.status, 400);

  const created = await request("/api/v1/users", {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dave", password: "password123", role: "ADMIN" }),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).role, "ADMIN");

  const dupRename = await request("/api/v1/users/dave", {
    method: "PATCH",
    ...asUser("admin", { username: "alice" }),
  });
  assert.equal(dupRename.status, 409);

  const badRole = await request("/api/v1/users/dave", {
    method: "PATCH",
    ...asUser("admin", { role: "SUPERUSER" }),
  });
  assert.equal(badRole.status, 400);

  // Give Alice a memo and attachment, then delete Alice and verify cleanup.
  const form = new FormData();
  form.append("file", new File(["alice-file"], "a.txt", { type: "text/plain" }));
  const attRes = await request("/api/v1/attachments", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokens.alice}` },
    body: form,
  });
  const att = await attRes.json();
  await request("/api/v1/memos", {
    method: "POST",
    ...asUser("alice", { content: "alice memo", visibility: "PUBLIC", attachments: [att.name] }),
  });

  const delUser = await request("/api/v1/users/alice", { method: "DELETE", ...asUser("admin") });
  assert.equal(delUser.status, 200);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS c FROM user WHERE username = 'alice'").get().c, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS c FROM memo WHERE creator_id = 2").get().c, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS c FROM attachment WHERE creator_id = 2").get().c, 0);
  assert.equal(objects.size, 0);
});

test("creates MEMO_MENTION inbox notifications and triggers Resend email without duplicating on edits", async () => {
  const sentEmails = [];
  globalThis.fetch = async (url, init) => {
    sentEmails.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
  };

  sqlite.prepare("INSERT INTO system_setting (name, value) VALUES ('instance/settings/NOTIFICATION', ?)")
    .run(JSON.stringify({ email: { enabled: true, apiKey: "re_test_key", fromEmail: "noreply@example.com", fromName: "Memos" } }));

  // Private memo must not notify other users.
  await request("/api/v1/memos", {
    method: "POST",
    ...asUser("alice", { content: "secret note @bob", visibility: "PRIVATE" }),
  });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS c FROM inbox").get().c, 0);

  // Public memo mentioning @bob and email foo@example.com should only notify bob once.
  const createRes = await request("/api/v1/memos", {
    method: "POST",
    ...asUser("alice", { content: "hello @bob, email foo@example.com and @alice", visibility: "PROTECTED" }),
  });
  assert.equal(createRes.status, 201);
  const createdMemo = await createRes.json();
  const memoUid = createdMemo.name.replace("memos/", "");

  // Wait a microtask tick for background email task when executionCtx is absent.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const bobInbox = sqlite.prepare("SELECT * FROM inbox WHERE receiver_id = 3").all();
  assert.equal(bobInbox.length, 1);
  assert.equal(JSON.parse(bobInbox[0].message).type, "MEMO_MENTION");
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].url, "https://api.resend.com/emails");
  assert.deepEqual(sentEmails[0].body.to, ["bob@example.com"]);

  // Editing memo to also mention @charlie must only notify charlie, not duplicate bob.
  await request(`/api/v1/memos/${memoUid}`, {
    method: "PATCH",
    ...asUser("alice", { content: "hello @bob and @charlie" }),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sqlite.prepare("SELECT COUNT(*) AS c FROM inbox WHERE receiver_id = 3").get().c, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS c FROM inbox WHERE receiver_id = 4").get().c, 1);
});
