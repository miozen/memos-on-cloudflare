import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import app from "../src/index.ts";
import { createAccessToken } from "../src/auth/jwt.ts";
import { DEFAULT_TAG_SUGGESTION_MODEL } from "../src/ai-models.ts";
import { DEFAULT_PKM_SECONDARY_TAGS, DEFAULT_PKM_TAG_SET } from "../src/default-tags.ts";
import { extractMemoTags, isValidTagText } from "../src/tags.ts";

const secret = "local-secondary-tags-ai-test-secret";
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
    INSTANCE_NAME: "secondary-tags-ai-test",
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

test("preset secondary dictionary has 139 valid tags and exactly matches frontend preset list", async () => {
  assert.equal(DEFAULT_PKM_SECONDARY_TAGS.length, 139);
  const seenLower = new Set();
  for (const tag of DEFAULT_PKM_SECONDARY_TAGS) {
    assert.ok(isValidTagText(tag), `invalid preset tag: ${tag}`);
    assert.deepEqual(extractMemoTags(`#${tag} 测试`), [tag]);
    const segments = tag.split("/");
    assert.equal(segments.length, 2);
    assert.ok(DEFAULT_PKM_TAG_SET.has(segments[0]));
    const lower = tag.toLowerCase();
    assert.equal(seenLower.has(lower), false, `duplicate preset tag: ${tag}`);
    seenLower.add(lower);
  }

  // Verify frontend static list matches backend list identically
  const frontendSource = readFileSync(new URL("../../web/src/lib/default-tags.ts", import.meta.url), "utf8");
  const match = frontendSource.match(/DEFAULT_PKM_PRESET_SECONDARY_TAGS_BY_ROOT[^=]*=\s*(\{[\s\S]*?\});/);
  assert.ok(match);
  const frontendMap = Function(`"use strict"; return (${match[1]});`)();
  const frontendFullTags = Object.entries(frontendMap).flatMap(([root, subs]) => subs.map((sub) => `${root}/${sub}`));
  assert.deepEqual(frontendFullTags, [...DEFAULT_PKM_SECONDARY_TAGS]);
});

test("deterministic validation enforces 12 roots, <=2 levels, max 1 new AI-coined secondary tag, treats preset tags as reuse, and preserves manual tags", async () => {
  env.AI = {
    async run() {
      return {
        response: JSON.stringify({
          tags: [
            "不存在的一级/子类",
            "技术/Cloudflare/D1",
            "技术/-bad",
            "0080ff",
            "技术/Cloudflare",
            "技术/自研引擎",
            "项目/临时实验",
            "日常",
          ],
        }),
      };
    },
  };

  const res = await request("/api/v1/ai/suggestTags", {
    method: "POST",
    ...asUser("alice", { content: "今天在 Cloudflare Workers 上调试自研引擎并做临时实验" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, "ai");
  // "技术/Cloudflare" is a preset -> reuse (does not consume new quota).
  // "技术/自研引擎" is AI-coined -> new; "项目/临时实验" is skipped because max 1 new is allowed.
  assert.deepEqual(body.tags, ["技术/Cloudflare", "技术/自研引擎", "日常"]);
  assert.deepEqual(body.suggestions, [
    { tag: "技术/Cloudflare", mode: "reuse" },
    { tag: "技术/自研引擎", mode: "new" },
    { tag: "日常", mode: "primary" },
  ]);

  // Manual tag capabilities remain completely unrestricted.
  const manualRes = await request("/api/v1/memos", {
    method: "POST",
    ...asUser("alice", { content: "#自定义一级/二级/三级 手动标签不受限制", visibility: "PRIVATE" }),
  });
  assert.equal(manualRes.status, 201);
  const manualMemo = await manualRes.json();
  assert.deepEqual(manualMemo.tags, ["自定义一级/二级/三级"]);
});

test("normalizes case variants against both preset and user D1 tags while preserving hyphens", async () => {
  await request("/api/v1/memos", {
    method: "POST",
    ...asUser("alice", { content: "#技术/AI-工具 已有标签笔记", visibility: "PRIVATE" }),
  });

  env.AI = {
    async run() {
      return {
        response: '<think>reasoning...</think>{"tags":[{"tag":"技术/cloudflare","action":"new"},{"tag":"技术/Rust语言","action":"new"}]}',
      };
    },
  };

  const res = await request("/api/v1/ai/suggestTags", {
    method: "POST",
    ...asUser("alice", { content: "研究 Cloudflare Workers 和 Rust 选型" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.tags, ["技术/Cloudflare", "技术/Rust语言"]);
  assert.deepEqual(body.suggestions, [
    { tag: "技术/Cloudflare", mode: "reuse" },
    { tag: "技术/Rust语言", mode: "new" },
  ]);
});

test("queries user tags directly from D1 without 40-tag truncation and enforces strict user isolation", async () => {
  // Insert 45 secondary tags for alice and 1 distinct secondary tag for bob.
  for (let i = 1; i <= 45; i++) {
    await request("/api/v1/memos", {
      method: "POST",
      ...asUser("alice", { content: `#技术/Topic${String(i).padStart(2, "0")} 笔记 ${i}`, visibility: "PRIVATE" }),
    });
  }
  await request("/api/v1/memos", {
    method: "POST",
    ...asUser("bob", { content: "#项目/BobSecretProject 隐私笔记", visibility: "PRIVATE" }),
  });

  // Archived memo tag should not be included as active reuse candidate.
  const archivedRes = await request("/api/v1/memos", {
    method: "POST",
    ...asUser("alice", { content: "#技术/ArchivedOnly 已归档标签", visibility: "PRIVATE" }),
  });
  const archivedMemo = await archivedRes.json();
  const archivedId = archivedMemo.name.split("/").pop();
  await request(`/api/v1/memos/${archivedId}`, {
    method: "PATCH",
    ...asUser("alice", { rowStatus: "ARCHIVED" }),
  });

  let capturedUserPrompt = "";
  env.AI = {
    async run(_model, input) {
      capturedUserPrompt = input.messages[1].content;
      return { response: '["技术/Topic45"]' };
    },
  };

  // Even without candidateTags and without KV cache, backend reads all 45 tags directly from D1.
  const res = await request("/api/v1/ai/suggestTags", {
    method: "POST",
    ...asUser("alice", { content: "继续补充 Topic45 相关配置" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.tags, ["技术/Topic45"]);
  assert.deepEqual(body.suggestions, [{ tag: "技术/Topic45", mode: "reuse" }]);
  assert.ok(capturedUserPrompt.includes("技术/Topic45"));
  assert.ok(capturedUserPrompt.includes("技术/Cloudflare"));
  assert.equal(capturedUserPrompt.includes("BobSecretProject"), false);
  assert.equal(capturedUserPrompt.includes("ArchivedOnly"), false);
});

test("prompt merges actual user tags and preset tags without duplicates", async () => {
  await request("/api/v1/memos", {
    method: "POST",
    ...asUser("alice", { content: "#技术/Cloudflare #技术/自研网关 已有标签", visibility: "PRIVATE" }),
  });

  let capturedUserPrompt = "";
  env.AI = {
    async run(_model, input) {
      capturedUserPrompt = input.messages[1].content;
      return { response: '["技术/Cloudflare"]' };
    },
  };

  const res = await request("/api/v1/ai/suggestTags", {
    method: "POST",
    ...asUser("alice", { content: "优化自研网关和 Cloudflare 路由" }),
  });
  assert.equal(res.status, 200);
  const techLine = capturedUserPrompt.split("\n").find((line) => line.startsWith("- 技术"));
  assert.ok(techLine);
  assert.ok(techLine.includes("[已用: 技术/Cloudflare, 技术/自研网关]"));
  assert.equal(techLine.match(/技术\/Cloudflare/g)?.length, 1);
  assert.ok(techLine.includes("技术/Docker"));
});

test("when user already selected primary category, prompt locks it and provides its secondary tags", async () => {
  await request("/api/v1/memos", {
    method: "POST",
    ...asUser("alice", { content: "#技术/Cloudflare #项目/Memos 已有记录", visibility: "PRIVATE" }),
  });

  let capturedUserPrompt = "";
  env.AI = {
    async run(_model, input) {
      capturedUserPrompt = input.messages[1].content;
      return { response: '["技术/Cloudflare"]' };
    },
  };

  const res = await request("/api/v1/ai/suggestTags", {
    method: "POST",
    ...asUser("alice", { content: "#技术 在 Cloudflare D1 上排查索引" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.tags, ["技术/Cloudflare"]);
  assert.ok(capturedUserPrompt.includes("用户已选一级分类（保留勿替换，优先在该分类下选择或补充二级标签）: 技术"));
  assert.ok(capturedUserPrompt.includes("技术/Cloudflare"));
  assert.equal(capturedUserPrompt.includes("项目/Memos"), false);
});

test("disables thinking for Qwen 3.8 / GLM-4.7 and retries cleanly if chat_template_kwargs is rejected", async () => {
  await request("/api/v1/instance/settings/AI", {
    method: "PATCH",
    ...asUser("alice", {
      value: JSON.stringify({ providers: [], tagSuggestion: { model: "@cf/qwen/qwen3.8-27b" } }),
    }),
  });

  const capturedPayloads = [];
  env.AI = {
    async run(_model, input) {
      capturedPayloads.push(input);
      if (input.chat_template_kwargs) {
        throw new Error("Unsupported chat_template_kwargs");
      }
      return { choices: [{ message: { content: '["技术/Cloudflare"]' } }] };
    },
  };

  const res = await request("/api/v1/ai/suggestTags", {
    method: "POST",
    ...asUser("alice", { content: "测试 Qwen 3.8 关闭思考与兼容重试" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, "ai");
  assert.deepEqual(body.tags, ["技术/Cloudflare"]);
  assert.equal(capturedPayloads.length, 2);
  assert.deepEqual(capturedPayloads[0].chat_template_kwargs, { enable_thinking: false });
  assert.equal(capturedPayloads[1].chat_template_kwargs, undefined);
});

test("Workers AI model setting persists via instance AI setting, takes effect immediately, and handles invalid config/errors safely", async () => {
  let calledModels = [];
  env.AI = {
    async run(model) {
      calledModels.push(model);
      return { response: '["技术/Cloudflare"]' };
    },
  };

  // Default model when unset
  const defaultRes = await request("/api/v1/ai/suggestTags", {
    method: "POST",
    ...asUser("alice", { content: "Cloudflare Workers 部署测试" }),
  });
  assert.equal(defaultRes.status, 200);
  assert.equal((await defaultRes.json()).model, DEFAULT_TAG_SUGGESTION_MODEL);
  assert.equal(calledModels[0], DEFAULT_TAG_SUGGESTION_MODEL);

  // Reject unsupported model via PATCH
  const invalidPatch = await request("/api/v1/instance/settings/AI", {
    method: "PATCH",
    ...asUser("alice", {
      value: JSON.stringify({ providers: [], tagSuggestion: { model: "@cf/invalid/nonexistent" } }),
    }),
  });
  assert.equal(invalidPatch.status, 400);

  // Save valid model -> takes effect immediately on next request
  const validPatch = await request("/api/v1/instance/settings/AI", {
    method: "PATCH",
    ...asUser("alice", {
      value: JSON.stringify({ providers: [], tagSuggestion: { model: "@cf/zai-org/glm-4.7-flash" } }),
    }),
  });
  assert.equal(validPatch.status, 200);

  const updatedRes = await request("/api/v1/ai/suggestTags", {
    method: "POST",
    ...asUser("alice", { content: "Cloudflare Workers 部署测试" }),
  });
  assert.equal(updatedRes.status, 200);
  const updatedBody = await updatedRes.json();
  assert.equal(updatedBody.model, "@cf/zai-org/glm-4.7-flash");
  assert.equal(calledModels[1], "@cf/zai-org/glm-4.7-flash");

  // Simulate legacy deprecated model -> auto-upgrades to -fast; and AI runtime throw falls back to heuristic with reason
  sqlite
    .prepare("UPDATE system_setting SET value = ? WHERE name = 'instance/settings/AI'")
    .run(JSON.stringify({ tagSuggestion: { model: "@cf/meta/llama-3.1-8b-instruct" } }));

  const legacyAliasRes = await request("/api/v1/ai/suggestTags", {
    method: "POST",
    ...asUser("alice", { content: "Cloudflare Workers 部署测试" }),
  });
  assert.equal(legacyAliasRes.status, 200);
  assert.equal((await legacyAliasRes.json()).model, DEFAULT_TAG_SUGGESTION_MODEL);

  // Supports OpenAI chat-completion choices format (used by GLM-4.7-Flash / Qwen 3.8)
  env.AI = {
    async run() {
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: '{"tags":[{"tag":"技术/Cloudflare","action":"new"}]}',
            },
          },
        ],
      };
    },
  };
  const choicesRes = await request("/api/v1/ai/suggestTags", {
    method: "POST",
    ...asUser("alice", { content: "排查 Cloudflare Workers 和 D1 性能" }),
  });
  assert.equal(choicesRes.status, 200);
  const choicesBody = await choicesRes.json();
  assert.equal(choicesBody.source, "ai");
  assert.deepEqual(choicesBody.tags, ["技术/Cloudflare"]);

  // Simulate corrupted DB config -> safely falls back to default model, and AI runtime throw falls back to heuristic
  sqlite
    .prepare("UPDATE system_setting SET value = ? WHERE name = 'instance/settings/AI'")
    .run(JSON.stringify({ tagSuggestion: { model: "@cf/legacy/removed" } }));

  env.AI = {
    async run(model) {
      calledModels.push(model);
      throw new Error("Simulated Workers AI outage");
    },
  };

  const fallbackRes = await request("/api/v1/ai/suggestTags", {
    method: "POST",
    ...asUser("alice", { content: "今天修复了 Cloudflare Workers 数据库 SQL 性能问题" }),
  });
  assert.equal(fallbackRes.status, 200);
  const fallbackBody = await fallbackRes.json();
  assert.equal(fallbackBody.model, DEFAULT_TAG_SUGGESTION_MODEL);
  assert.equal(fallbackBody.source, "heuristic");
  assert.ok(fallbackBody.fallbackReason?.includes("Simulated Workers AI outage"));
  assert.ok(fallbackBody.tags.includes("技术"));
  assert.equal(calledModels[3], DEFAULT_TAG_SUGGESTION_MODEL);

  // Saving memos still works cleanly even when AI fails
  const memoSaveRes = await request("/api/v1/memos", {
    method: "POST",
    ...asUser("alice", { content: "#技术/Cloudflare AI故障时保存测试", visibility: "PRIVATE" }),
  });
  assert.equal(memoSaveRes.status, 201);
});

test("filtering by primary tag retrieves secondary-only memos and tags:rename merges secondary tags cleanly", async () => {
  await request("/api/v1/memos", {
    method: "POST",
    ...asUser("alice", { content: "#技术/Cloudflare Workers 部署笔记", visibility: "PRIVATE" }),
  });
  await request("/api/v1/memos", {
    method: "POST",
    ...asUser("alice", { content: "#技术/CF D1 查询优化", visibility: "PRIVATE" }),
  });

  const primaryFilterRes = await request(`/api/v1/memos?filter=${encodeURIComponent('tag in ["技术"]')}`, asUser("alice"));
  assert.equal(primaryFilterRes.status, 200);
  assert.equal((await primaryFilterRes.json()).memos.length, 2);

  const subFilterRes = await request(`/api/v1/memos?filter=${encodeURIComponent('tag in ["技术/Cloudflare"]')}`, asUser("alice"));
  assert.equal(subFilterRes.status, 200);
  assert.equal((await subFilterRes.json()).memos.length, 1);

  const mergeRes = await request("/api/v1/memos/tags:rename", {
    method: "POST",
    ...asUser("alice", { oldTag: "技术/CF", newTag: "技术/Cloudflare" }),
  });
  assert.equal(mergeRes.status, 200);
  assert.equal((await mergeRes.json()).updatedCount, 1);

  const afterSubFilterRes = await request(`/api/v1/memos?filter=${encodeURIComponent('tag in ["技术/Cloudflare"]')}`, asUser("alice"));
  assert.equal((await afterSubFilterRes.json()).memos.length, 2);
});

test("simulated 36-note sequential cold-start classification verifies reuse growth and zero duplicate tags", async () => {
  // NOTE: This is a deterministic Mock AI simulator that inspects the live D1-backed
  // secondary tag list inside each prompt to verify the end-to-end backend loop.
  env.AI = {
    async run(_model, input) {
      const userPrompt = input.messages[1].content;
      const noteMatch = userPrompt.match(/笔记正文：\n([\s\S]*)$/);
      const note = (noteMatch?.[1] ?? "").toLowerCase();
      const hasExisting = (tag) => userPrompt.includes(tag);

      let tags = [];
      if (note.includes("cloudflare") || note.includes("workers") || note.includes("r2") || note.includes("d1") || note.includes("cf ")) {
        tags = [{ tag: "技术/Cloudflare", action: hasExisting("技术/Cloudflare") ? "reuse" : "new" }];
      } else if (note.includes("ai") || note.includes("prompt") || note.includes("大模型") || note.includes("llm")) {
        tags = [{ tag: "技术/AI工具", action: hasExisting("技术/AI工具") ? "reuse" : "new" }];
      } else if (note.includes("谱匠")) {
        tags = [{ tag: "项目/谱匠", action: hasExisting("项目/谱匠") ? "reuse" : "new" }];
      } else if (note.includes("memos")) {
        tags = [{ tag: "项目/Memos", action: hasExisting("项目/Memos") ? "reuse" : "new" }];
      } else if (note.includes("房子") || note.includes("装修") || note.includes("户型")) {
        tags = [{ tag: "家庭/房屋设计", action: hasExisting("家庭/房屋设计") ? "reuse" : "new" }];
      } else if (note.includes("族谱") || note.includes("祖辈") || note.includes("迁徙")) {
        tags = [{ tag: "家族/迁徙历史", action: hasExisting("家族/迁徙历史") ? "reuse" : "new" }];
      } else if (note.includes("基金") || note.includes("etf") || note.includes("定投")) {
        tags = [{ tag: "财务/投资", action: hasExisting("财务/投资") ? "reuse" : "new" }];
      } else if (note.includes("跑步") || note.includes("配速") || note.includes("拉伸")) {
        tags = [{ tag: "健康/运动", action: hasExisting("健康/运动") ? "reuse" : "new" }];
      } else if (note.includes("云南") || note.includes("自驾") || note.includes("攻略")) {
        tags = [{ tag: "旅行/旅行攻略", action: hasExisting("旅行/旅行攻略") ? "reuse" : "new" }];
      } else if (note.includes("门店") || note.includes("客流") || note.includes("排班")) {
        tags = [{ tag: "工作/门店经营", action: hasExisting("工作/门店经营") ? "reuse" : "new" }];
      } else if (note.includes("灵光") || note.includes("点子")) {
        tags = [{ tag: "灵感", action: "primary" }];
      } else if (note.includes("记得") || note.includes("待办")) {
        tags = [{ tag: "待办", action: "primary" }];
      } else {
        tags = [{ tag: "日常", action: "primary" }];
      }

      return { response: JSON.stringify({ tags }) };
    },
  };

  const samples = [
    "首次尝试用 Cloudflare Workers 搭建边缘接口",
    "研究 Cloudflare D1 的单库容量和索引优化",
    "配置 Cloudflare R2 桶用于静态图片托管",
    "排查 CF Workers 路由缓存失效问题",
    "测试 Cloudflare Pages 与 Workers 联合部署",
    "整理谱匠项目的数据库表结构设计",
    "谱匠新增了导出高清家谱长图的功能",
    "修复谱匠前端树形画布拖拽卡顿",
    "今天去超市买了牛奶和水果，顺路散了步",
    "晚上吃了一碗牛肉面，雨下得挺大",
    "对比了几款大模型在中文标签分类上的 Prompt 效果",
    "用 AI 工具整理每周阅读摘要的工作流",
    "LLM 结构化 JSON 输出的温度参数调优记录",
    "Memos 二级标签动态归类方案讨论",
    "优化 Memos 侧边栏树形标签的默认展示体验",
    "客厅装修打算做无主灯设计，预留投影幕布槽",
    "对比了几种实木地板和微水泥的房屋装修报价",
    "户型改造：把阳台打通并入书房区域",
    "整理太爷爷一辈从江西迁徙到湖南的口述记录",
    "核对老家族谱世系表中的迁徙年份",
    "本月沪深300 ETF 定投扣款记录与复盘",
    "记录一笔红利低波基金的资产再平衡配置",
    "晨跑 5 公里，平均配速 5 分 40 秒",
    "跑完步后做 15 分钟小腿和髋部拉伸",
    "制定国庆去云南大理和丽江的自驾路线攻略",
    "云南旅行攻略：提前预订洱海东岸民宿和租车",
    "统计门店周末两天客流高峰与促销转化率",
    "下周门店经营排班表与耗材补货确认",
    "突发点子：做一个按时间轴对比家庭照片的小工具",
    "突然想到一个改善夜间阅读模式对比度的创意",
    "记得周末去配一把小区门禁卡",
    "待办：明天上午把快递寄出并续费宽带",
    "今天天气转凉，把厚外套翻出来洗了",
    "Cloudflare Turnstile 验证接入文档速记",
    "谱匠移动端手势缩放体验继续微调",
    "总结 AI 辅助个人知识库冷启动的最佳实践",
  ];

  let reuseCount = 0;
  let newCount = 0;
  let primaryCount = 0;
  const coinedNewTags = new Set();

  for (const content of samples) {
    const suggestRes = await request("/api/v1/ai/suggestTags", {
      method: "POST",
      ...asUser("alice", { content }),
    });
    assert.equal(suggestRes.status, 200);
    const suggestBody = await suggestRes.json();
    assert.ok(suggestBody.tags.length >= 1 && suggestBody.tags.length <= 3);

    const newItems = suggestBody.suggestions.filter((s) => s.mode === "new");
    assert.ok(newItems.length <= 1);

    for (const item of suggestBody.suggestions) {
      if (item.mode === "new") {
        assert.equal(coinedNewTags.has(item.tag), false);
        coinedNewTags.add(item.tag);
        newCount++;
      } else if (item.mode === "reuse") {
        reuseCount++;
      } else {
        primaryCount++;
      }
    }

    const nextContent = `${content} ${suggestBody.tags.map((t) => `#${t}`).join(" ")}`;
    const saveRes = await request("/api/v1/memos", {
      method: "POST",
      ...asUser("alice", { content: nextContent, visibility: "PRIVATE" }),
    });
    assert.equal(saveRes.status, 201);
  }

  assert.equal(newCount, coinedNewTags.size);
  assert.ok(reuseCount >= 25, `expected strong preset+real reuse across 36 notes, got ${reuseCount}`);
  assert.ok(primaryCount >= 5, `expected primary-only fallback for casual notes, got ${primaryCount}`);
});
