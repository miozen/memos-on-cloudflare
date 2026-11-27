import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";
import * as settingDB from "../db/setting";
import {
  DEFAULT_PKM_TAG_NAMES,
  DEFAULT_PKM_TAG_SET,
  PKM_CATEGORY_SPECS,
} from "../default-tags";
import { extractMemoTags, isValidTagText } from "../tags";
import { safeJsonParse } from "../validation";
import { resolveTagSuggestionModel } from "../ai-models";

type AIApp = { Bindings: Env; Variables: { user: UserPayload } };

export const aiRoutes = new Hono<AIApp>();

const MAX_AUDIO_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_SUGGESTED_TAGS = 3;
const MAX_NEW_SECONDARY_TAGS = 1;

export type TagSuggestionMode = "reuse" | "new" | "primary";

export interface TagSuggestionItem {
  tag: string;
  mode: TagSuggestionMode;
}

export interface UserTagIndex {
  counts: Map<string, number>;
  realTags: Set<string>;
  lowerToCanonical: Map<string, string>;
  secondaryByRoot: Map<string, string[]>;
}

aiRoutes.post("/transcribe", authRequired, async (c) => {
  const contentType = c.req.header("content-type") || "";

  if (!c.env.AI) {
    return c.json({ error: "AI binding not configured" }, 501);
  }

  let audioData: ArrayBuffer;
  let requestedLanguage = "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return c.json({ error: "No audio file provided" }, 400);
    if (file.size > MAX_AUDIO_SIZE_BYTES) {
      return c.json({ error: "Audio file exceeds the 25MB limit" }, 413);
    }
    audioData = await file.arrayBuffer();
    if (audioData.byteLength > MAX_AUDIO_SIZE_BYTES) {
      return c.json({ error: "Audio file exceeds the 25MB limit" }, 413);
    }
    requestedLanguage = String(formData.get("language") || "");
  } else {
    return c.json({ error: "Expected multipart/form-data" }, 400);
  }

  // Get AI settings for model/language config
  let model = "@cf/openai/whisper";
  let language = requestedLanguage;
  const aiSettingRow = await settingDB.getInstanceSetting(c.env.DB, "AI");
  if (aiSettingRow) {
    try {
      const parsed = JSON.parse(aiSettingRow.value);
      if (parsed.transcription?.model) model = parsed.transcription.model;
      if (!language && parsed.transcription?.language) language = parsed.transcription.language;
    } catch {}
  }

  const payload: Record<string, unknown> = {
    audio: [...new Uint8Array(audioData)],
  };
  if (language) {
    payload.language = language;
  }

  const result = await c.env.AI.run(model as any, payload as any);

  return c.json({ text: (result as any).text || "" });
});

const PKM_TAG_KEYWORDS: Record<string, string[]> = {
  日常: ["日常", "今天", "随手", "生活", "晚饭", "早起", "日记", "记录", "周末"],
  灵感: ["灵感", "想法", "创意", "点子", "突然想到", "脑洞", "构思"],
  待办: ["待办", "todo", "记得", "准备", "需要", "安排", "计划", "截止", "- [ ]"],
  资料: ["资料", "收藏", "文章", "教程", "文档", "参考", "整理", "摘要", "http://", "https://"],
  技术: ["代码", "软件", "编程", "ai", "网络", "worker", "react", "typescript", "api", "bug", "部署", "数据库", "sql", "cloudflare", "git"],
  项目: ["项目", "需求", "开发", "上线", "迭代", "里程碑", "排期", "架构"],
  工作: ["工作", "会议", "汇报", "客户", "商业", "经营", "合作", "团队"],
  财务: ["财务", "投资", "消费", "账目", "记账", "报销", "工资", "基金", "股票", "预算", "元"],
  家族: ["家族", "族谱", "宗族", "祖辈", "世系", "老家", "家族史"],
  家庭: ["家庭", "家里", "家人", "房子", "房屋", "装修", "亲友", "爸妈", "孩子", "妻子", "老公", "客厅", "卧室"],
  健康: ["健康", "运动", "跑步", "健身", "体检", "医院", "睡眠", "饮食", "养生", "吃药"],
  旅行: ["旅行", "旅游", "出差", "机票", "酒店", "景点", "自驾", "攻略", "打卡"],
};

async function fetchUserRealTagCounts(db: D1Database, userId: number): Promise<Map<string, number>> {
  const { results } = await db
    .prepare("SELECT payload FROM memo WHERE creator_id = ? AND row_status = 'NORMAL'")
    .bind(userId)
    .all<{ payload: string }>();

  const counts = new Map<string, number>();
  for (const row of results) {
    const payload = safeJsonParse<{ tags?: unknown }>(row.payload, {});
    if (!Array.isArray(payload.tags)) continue;
    for (const rawTag of payload.tags) {
      if (typeof rawTag !== "string" || !rawTag) continue;
      counts.set(rawTag, (counts.get(rawTag) ?? 0) + 1);
    }
  }
  return counts;
}

export function buildUserTagIndex(counts: Map<string, number>): UserTagIndex {
  const realTags = new Set<string>();
  const lowerEntries = new Map<string, { tag: string; count: number }>();
  const secondaryEntriesByRoot = new Map<string, Array<{ tag: string; count: number }>>();

  for (const root of DEFAULT_PKM_TAG_NAMES) {
    secondaryEntriesByRoot.set(root, []);
  }

  for (const [tag, count] of counts.entries()) {
    if (!isValidTagText(tag)) continue;
    const segments = tag.split("/");
    if (segments.length > 2) continue;
    const root = segments[0];
    if (!DEFAULT_PKM_TAG_SET.has(root)) continue;

    realTags.add(tag);

    const lower = tag.toLowerCase();
    const existingLower = lowerEntries.get(lower);
    if (!existingLower || count > existingLower.count || (count === existingLower.count && tag < existingLower.tag)) {
      lowerEntries.set(lower, { tag, count });
    }

    if (segments.length === 2) {
      secondaryEntriesByRoot.get(root)!.push({ tag, count });
    }
  }

  const lowerToCanonical = new Map<string, string>();
  for (const [lower, entry] of lowerEntries.entries()) {
    lowerToCanonical.set(lower, entry.tag);
  }

  const secondaryByRoot = new Map<string, string[]>();
  for (const [root, entries] of secondaryEntriesByRoot.entries()) {
    entries.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    secondaryByRoot.set(
      root,
      entries.map((entry) => entry.tag),
    );
  }

  return { counts, realTags, lowerToCanonical, secondaryByRoot };
}

function extractTextFromAiResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (!result || typeof result !== "object") {
    return "";
  }

  const obj = result as Record<string, unknown>;
  if (typeof obj.response === "string") {
    return obj.response;
  }
  if (obj.response && typeof obj.response === "object") {
    return JSON.stringify(obj.response);
  }

  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const firstChoice = obj.choices[0] as Record<string, unknown> | undefined;
    const message = firstChoice?.message as Record<string, unknown> | undefined;
    if (typeof message?.content === "string" && message.content.trim()) {
      return message.content;
    }
    if (typeof firstChoice?.text === "string" && firstChoice.text.trim()) {
      return firstChoice.text;
    }
  }

  if (obj.result && typeof obj.result === "object") {
    return extractTextFromAiResult(obj.result);
  }

  return "";
}

function extractRawTagCandidatesFromAiText(rawText: string): string[] {
  const withoutThinking = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const parseCandidateArray = (items: unknown[]): string[] => {
    const out: string[] = [];
    for (const item of items) {
      if (typeof item === "string") {
        out.push(item);
      } else if (item && typeof item === "object" && typeof (item as { tag?: unknown }).tag === "string") {
        out.push((item as { tag: string }).tag);
      }
    }
    return out;
  };

  const tryParseJson = (snippet: string): string[] | null => {
    try {
      const parsed = JSON.parse(snippet) as unknown;
      if (Array.isArray(parsed)) {
        return parseCandidateArray(parsed);
      }
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { tags?: unknown }).tags)) {
        return parseCandidateArray((parsed as { tags: unknown[] }).tags);
      }
    } catch {
      return null;
    }
    return null;
  };

  const direct = tryParseJson(withoutThinking);
  if (direct) return direct;

  const objMatch = withoutThinking.match(/\{[\s\S]*\}/);
  if (objMatch) {
    const parsedObj = tryParseJson(objMatch[0]);
    if (parsedObj) return parsedObj;
  }

  const arrMatch = withoutThinking.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    const parsedArr = tryParseJson(arrMatch[0]);
    if (parsedArr) return parsedArr;
  }

  return [];
}

export function validateAndNormalizeTagSuggestions(
  rawCandidates: string[],
  contentTags: string[],
  tagIndex: UserTagIndex,
): TagSuggestionItem[] {
  const contentLowerSet = new Set(contentTags.map((tag) => tag.toLowerCase()));
  const contentSubRoots = new Set(contentTags.filter((tag) => tag.includes("/")).map((tag) => tag.split("/")[0]));
  const lockedRoots = new Set(
    contentTags.map((tag) => tag.split("/")[0]).filter((root) => DEFAULT_PKM_TAG_SET.has(root)),
  );

  const seenLower = new Set<string>();
  const preliminary: TagSuggestionItem[] = [];
  let newSecondaryCount = 0;

  for (const raw of rawCandidates) {
    if (typeof raw !== "string") continue;
    const cleaned = raw.trim().replace(/^#+/, "").replace(/^["']|["']$/g, "");
    if (!cleaned || /\s/.test(cleaned) || !isValidTagText(cleaned)) {
      continue;
    }

    const segments = cleaned.split("/");
    if (segments.length > 2) {
      continue;
    }

    const root = segments[0];
    if (!DEFAULT_PKM_TAG_SET.has(root)) {
      continue;
    }

    const canonical = tagIndex.lowerToCanonical.get(cleaned.toLowerCase()) ?? cleaned;
    const canonicalLower = canonical.toLowerCase();

    if (contentLowerSet.has(canonicalLower) || seenLower.has(canonicalLower)) {
      continue;
    }

    const canonicalSegments = canonical.split("/");
    if (canonicalSegments.length === 1) {
      if (contentSubRoots.has(root) || lockedRoots.has(root)) {
        continue;
      }
    }

    const mode: TagSuggestionMode =
      canonicalSegments.length === 1 ? "primary" : tagIndex.realTags.has(canonical) ? "reuse" : "new";

    if (mode === "new") {
      if (newSecondaryCount >= MAX_NEW_SECONDARY_TAGS) {
        continue;
      }
      newSecondaryCount++;
    }

    seenLower.add(canonicalLower);
    preliminary.push({ tag: canonical, mode });
    if (preliminary.length >= MAX_SUGGESTED_TAGS) {
      break;
    }
  }

  // If the batch recommends both `root/sub` and bare `root`, drop redundant bare `root`.
  const batchSubRoots = new Set(
    preliminary.filter((item) => item.tag.includes("/")).map((item) => item.tag.split("/")[0]),
  );

  return preliminary.filter((item) => item.tag.includes("/") || !batchSubRoots.has(item.tag));
}

export function suggestTagsHeuristically(
  content: string,
  tagIndex: UserTagIndex,
  contentTags: string[],
): TagSuggestionItem[] {
  const normalized = content.toLowerCase();
  const lockedRoots = new Set(
    contentTags.map((tag) => tag.split("/")[0]).filter((root) => DEFAULT_PKM_TAG_SET.has(root)),
  );
  const scored: Array<{ tag: string; score: number }> = [];

  const rootsToCheck = lockedRoots.size > 0 ? [...lockedRoots] : [...DEFAULT_PKM_TAG_NAMES];
  for (const root of rootsToCheck) {
    const existingSubs = tagIndex.secondaryByRoot.get(root) ?? [];
    for (const subTag of existingSubs) {
      const leaf = subTag.split("/")[1]?.toLowerCase() ?? "";
      if (leaf.length >= 2 && normalized.includes(leaf)) {
        scored.push({ tag: subTag, score: 10 + Math.min(leaf.length, 10) });
      }
    }
  }

  for (const tag of DEFAULT_PKM_TAG_NAMES) {
    let score = 0;
    if (normalized.includes(tag.toLowerCase())) {
      score += 3;
    }
    const keywords = PKM_TAG_KEYWORDS[tag];
    if (keywords) {
      for (const keyword of keywords) {
        if (normalized.includes(keyword)) {
          score += 2;
        }
      }
    }
    if (score > 0) {
      scored.push({ tag, score });
    }
  }

  const ordered = scored.sort((a, b) => b.score - a.score).map((entry) => entry.tag);
  return validateAndNormalizeTagSuggestions(ordered, contentTags, tagIndex);
}

function buildTagSuggestionPrompts(
  content: string,
  contentTags: string[],
  tagIndex: UserTagIndex,
): { systemPrompt: string; userPrompt: string } {
  const lockedRoots = Array.from(
    new Set(contentTags.map((tag) => tag.split("/")[0]).filter((root) => DEFAULT_PKM_TAG_SET.has(root))),
  );

  const categoryReference = PKM_CATEGORY_SPECS.map(
    (spec) => `${spec.name}（${spec.basis}，如 ${spec.granularityExamples.slice(0, 2).join("/")}）`,
  ).join("、");

  const systemPrompt = [
    "你是个人笔记标签助手，请为笔记推荐 1～3 个中文或常见英文标签。",
    "",
    `固定一级分类（共12个）：${categoryReference}。`,
    "",
    "归类建议：",
    "1. 只要笔记有明确主题、技术产品、项目名或具体场景，优先推荐「一级/二级」（如 技术/Cloudflare、项目/谱匠、日常/生活感悟）；只有零碎无主题随笔才只给一级标签。",
    "2. 优先复用下方“已有二级标签”里相近或同系列的标签（如 Workers/D1/R2 都复用 技术/Cloudflare）。",
    "3. 需要新建时，提炼一个简短、通用、以后能继续用的主题词，最多一个 /（不要三级）。",
    "4. 常见区分：通用技术/工具归「技术」，自己推进的独立项目归「项目」；零星消费体验归「日常」，理财/账目/成本归「财务」。",
    "",
    '仅返回 JSON 字符串数组（不要加 # 或多余文字），例如：["技术/Cloudflare"]',
  ].join("\n");

  const existingTagLines: string[] = [];
  if (lockedRoots.length > 0) {
    existingTagLines.push(`用户已选一级分类（保留勿替换，优先在该分类下选或提炼二级标签）: ${lockedRoots.join("、")}`);
    for (const root of lockedRoots) {
      const subs = tagIndex.secondaryByRoot.get(root) ?? [];
      existingTagLines.push(`- ${root} 已有二级标签: ${subs.length > 0 ? subs.join(", ") : "暂无"}`);
    }
  } else {
    const populatedLines: string[] = [];
    for (const root of DEFAULT_PKM_TAG_NAMES) {
      const subs = tagIndex.secondaryByRoot.get(root) ?? [];
      if (subs.length > 0) {
        populatedLines.push(`- ${root}: ${subs.join(", ")}`);
      }
    }
    if (populatedLines.length > 0) {
      existingTagLines.push("已有二级标签（优先复用）：", ...populatedLines);
    } else {
      existingTagLines.push("已有二级标签：暂无（请根据笔记主题自然提炼）");
    }
  }

  const userPrompt = [
    ...existingTagLines,
    `正文已有标签: ${contentTags.length > 0 ? contentTags.join(", ") : "无"}`,
    "",
    "笔记正文：",
    content.slice(0, 3000),
  ].join("\n");

  return { systemPrompt, userPrompt };
}

async function runTagSuggestionAi(
  ai: Ai,
  model: string,
  messages: Array<{ role: string; content: string }>,
): Promise<unknown> {
  const basePayload = {
    messages,
    max_tokens: 512,
    temperature: 0.2,
  };

  const supportsThinkingToggle = model === "@cf/qwen/qwen3.8-27b" || model === "@cf/zai-org/glm-4.7-flash";
  if (!supportsThinkingToggle) {
    return ai.run(model as any, basePayload as any);
  }

  try {
    return await ai.run(
      model as any,
      {
        ...basePayload,
        chat_template_kwargs: { enable_thinking: false },
      } as any,
    );
  } catch (error) {
    console.warn(`Retrying ${model} without chat_template_kwargs`, error);
    return ai.run(model as any, basePayload as any);
  }
}

aiRoutes.post("/suggestTags", authRequired, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ content?: unknown; candidateTags?: unknown }>();
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    return c.json({ error: "Content is required" }, 400);
  }

  const [realTagCounts, aiSettingRow] = await Promise.all([
    fetchUserRealTagCounts(c.env.DB, user.id),
    settingDB.getInstanceSetting(c.env.DB, "AI"),
  ]);

  const tagIndex = buildUserTagIndex(realTagCounts);
  const contentTags = extractMemoTags(content);
  const { model, fallbackReason } = resolveTagSuggestionModel(aiSettingRow?.value);
  if (fallbackReason) {
    console.warn(fallbackReason);
  }

  let heuristicReason = !c.env.AI || typeof c.env.AI.run !== "function" ? "ai_binding_missing" : "";

  if (c.env.AI && typeof c.env.AI.run === "function") {
    try {
      const { systemPrompt, userPrompt } = buildTagSuggestionPrompts(content, contentTags, tagIndex);
      const result = await runTagSuggestionAi(c.env.AI, model, [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]);

      const responseText = extractTextFromAiResult(result);
      if (!responseText.trim()) {
        heuristicReason = "ai_empty_response";
      } else {
        const rawCandidates = extractRawTagCandidatesFromAiText(responseText);
        const suggestions = validateAndNormalizeTagSuggestions(rawCandidates, contentTags, tagIndex);

        if (suggestions.length > 0) {
          return c.json({
            tags: suggestions.map((item) => item.tag),
            suggestions,
            model,
            source: "ai",
          });
        }
        heuristicReason = "ai_parse_or_validation_empty";
      }
    } catch (error) {
      console.warn("AI tag suggestion fell back to heuristics", error);
      heuristicReason = `ai_error: ${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`;
    }
  }

  const heuristicSuggestions = suggestTagsHeuristically(content, tagIndex, contentTags);
  return c.json({
    tags: heuristicSuggestions.map((item) => item.tag),
    suggestions: heuristicSuggestions,
    model,
    source: "heuristic",
    ...(heuristicReason ? { fallbackReason: heuristicReason } : {}),
  });
});
