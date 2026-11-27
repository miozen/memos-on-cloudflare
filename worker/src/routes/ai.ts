import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";
import * as settingDB from "../db/setting";
import {
  DEFAULT_PKM_TAG_NAMES,
  DEFAULT_PKM_TAG_SET,
  PKM_CATEGORY_BOUNDARIES,
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

function extractRawTagCandidatesFromAiText(rawText: string): string[] {
  const withoutThinking = rawText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const objMatch = withoutThinking.match(/\{[\s\S]*\}/);
  const arrMatch = withoutThinking.match(/\[[\s\S]*\]/);

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

  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]) as { tags?: unknown };
      if (Array.isArray(parsed?.tags)) {
        return parseCandidateArray(parsed.tags);
      }
    } catch {
      // Fall through to array extraction
    }
  }

  if (arrMatch) {
    try {
      const parsed = JSON.parse(arrMatch[0]);
      if (Array.isArray(parsed)) {
        return parseCandidateArray(parsed);
      }
    } catch {
      return [];
    }
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
    (spec) => `- ${spec.name}（${spec.basis}，粒度参考：${spec.granularityExamples.join("、")}）`,
  ).join("\n");

  const boundaryReference = PKM_CATEGORY_BOUNDARIES.map((line) => `- ${line}`).join("\n");

  const systemPrompt = [
    "你是个人知识库（Memos）的标签归类助手。请为当前笔记推荐 1～3 个最合适的标签。",
    "",
    "【固定 12 个一级分类及粒度参考（示例仅解释分类粒度，不是预先存在的标签清单）】",
    categoryReference,
    "",
    "【相近分类语义边界】",
    boundaryReference,
    "",
    "【决策优先级（严格遵守）】",
    "1. 精确复用：已有二级标签准确匹配笔记主题时，直接复用。",
    "2. 语义复用：已有近义或上位二级标签可合理覆盖时（如 Cloudflare D1/R2/Workers 复用 技术/Cloudflare，不要新造 技术/CF），优先复用。",
    "3. 谨慎新建：确无合适已有二级标签，且当前主题独立、通用、长期稳定、高度概括（不含日期/版本号/一次性报错状态），才新建二级标签。",
    "4. 保留一级：内容偏随手记录或暂不需要二级细分时，仅推荐一级标签。",
    "",
    "【硬性约束】",
    "- 一级分类必须且只能是上述 12 个之一；禁止三级及以上标签（最多一个 /）。",
    "- 每条笔记推荐 1～3 个标签；每次最多新增 1 个二级标签；不强制生成二级标签。",
    "- 如果用户已选择一级标签，不得擅自替换该分类，应优先围绕该分类补充或推荐合适的二级标签。",
    "- 不要重复笔记正文中已有的相同标签。",
    "- 只输出合法 JSON，不要输出思考过程、Markdown 代码块或任何额外解释。",
    '输出格式：{"tags":[{"tag":"技术/Cloudflare","action":"reuse"}]}，action 取值为 reuse | new | primary。',
  ].join("\n");

  const existingTagLines: string[] = [];
  if (lockedRoots.length > 0) {
    existingTagLines.push(`用户已选一级分类（不可替换）: ${lockedRoots.join("、")}`);
    existingTagLines.push("对应一级分类下当前真实存在的全部二级标签：");
    for (const root of lockedRoots) {
      const subs = tagIndex.secondaryByRoot.get(root) ?? [];
      existingTagLines.push(`- ${root}: ${subs.length > 0 ? subs.join(", ") : "（暂无二级标签）"}`);
    }
  } else {
    existingTagLines.push("当前用户库中真实存在的全部二级标签（按一级分类分组）：");
    for (const root of DEFAULT_PKM_TAG_NAMES) {
      const subs = tagIndex.secondaryByRoot.get(root) ?? [];
      existingTagLines.push(`- ${root}: ${subs.length > 0 ? subs.join(", ") : "（暂无）"}`);
    }
  }

  const userPrompt = [
    ...existingTagLines,
    `笔记正文中已包含的标签: ${contentTags.length > 0 ? contentTags.join(", ") : "无"}`,
    "",
    "笔记正文：",
    content.slice(0, 3000),
  ].join("\n");

  return { systemPrompt, userPrompt };
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

  if (c.env.AI && typeof c.env.AI.run === "function") {
    try {
      const { systemPrompt, userPrompt } = buildTagSuggestionPrompts(content, contentTags, tagIndex);
      const result = await c.env.AI.run(model as any, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 200,
        temperature: 0.15,
      });

      const rawResult = result as unknown as { response?: unknown } | null;
      const responseText = typeof rawResult?.response === "string" ? rawResult.response : "";
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
    } catch (error) {
      console.warn("AI tag suggestion fell back to heuristics", error);
    }
  }

  const heuristicSuggestions = suggestTagsHeuristically(content, tagIndex, contentTags);
  return c.json({
    tags: heuristicSuggestions.map((item) => item.tag),
    suggestions: heuristicSuggestions,
    model,
    source: "heuristic",
  });
});
