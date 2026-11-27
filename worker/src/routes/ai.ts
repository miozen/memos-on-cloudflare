import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";
import * as settingDB from "../db/setting";
import { DEFAULT_PKM_TAG_NAMES } from "../default-tags";
import { extractMemoTags } from "../tags";

type AIApp = { Bindings: Env; Variables: { user: UserPayload } };

export const aiRoutes = new Hono<AIApp>();

const MAX_AUDIO_SIZE_BYTES = 25 * 1024 * 1024;

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

export function suggestTagsHeuristically(content: string, candidateTags: string[], existingTags: Set<string>): string[] {
  const normalized = content.toLowerCase();
  const scored: Array<{ tag: string; score: number }> = [];

  for (const tag of candidateTags) {
    if (!tag || existingTags.has(tag)) continue;
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

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.tag);
}

function parseSuggestedTagsFromAiResponse(rawText: string, existingTags: Set<string>): string[] {
  const trimmed = rawText.trim();
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    return [];
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const cleaned = item.trim().replace(/^#+/, "");
      if (!cleaned || cleaned.length > 30 || /\s/.test(cleaned) || existingTags.has(cleaned) || seen.has(cleaned)) {
        continue;
      }
      seen.add(cleaned);
      tags.push(cleaned);
      if (tags.length >= 3) break;
    }
    return tags;
  } catch {
    return [];
  }
}

aiRoutes.post("/suggestTags", authRequired, async (c) => {
  const body = await c.req.json<{ content?: unknown; candidateTags?: unknown }>();
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    return c.json({ error: "Content is required" }, 400);
  }

  const extraCandidates = Array.isArray(body.candidateTags)
    ? body.candidateTags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim().replace(/^#+/, ""))
        .filter((tag) => tag.length > 0 && tag.length <= 40 && !/\s/.test(tag))
        .slice(0, 40)
    : [];
  const candidatePool = Array.from(new Set([...DEFAULT_PKM_TAG_NAMES, ...extraCandidates]));
  const existingTags = new Set(extractMemoTags(content));

  if (c.env.AI && typeof c.env.AI.run === "function") {
    try {
      const result = await c.env.AI.run("@cf/meta/llama-3.1-8b-instruct" as any, {
        messages: [
          {
            role: "system",
            content:
              "You suggest 1 to 3 concise Chinese or English tags for a personal note. Prefer tags from the provided candidate list when relevant. Reply ONLY with a JSON array of tag strings without leading #, e.g. [\"技术\",\"项目\"].",
          },
          {
            role: "user",
            content: `Candidate tags: ${candidatePool.join(", ")}\nAlready tagged: ${[...existingTags].join(", ") || "none"}\n\nNote content:\n${content.slice(0, 3000)}`,
          },
        ],
        max_tokens: 120,
        temperature: 0.2,
      });

      const rawResult = result as unknown as { response?: unknown } | null;
      const responseText = typeof rawResult?.response === "string" ? rawResult.response : "";
      const aiTags = parseSuggestedTagsFromAiResponse(responseText, existingTags);
      if (aiTags.length > 0) {
        return c.json({ tags: aiTags, source: "ai" });
      }
    } catch (error) {
      console.warn("AI tag suggestion fell back to heuristics", error);
    }
  }

  const heuristicTags = suggestTagsHeuristically(content, candidatePool, existingTags);
  return c.json({ tags: heuristicTags, source: "heuristic" });
});
