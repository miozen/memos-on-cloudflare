import { deleteCachedKeys } from "./cache";
import { getInstanceSetting, getSystemSetting, normalizeInstanceSettingName, setSystemSetting } from "./db/setting";

export interface TagColor {
  red: number;
  green: number;
  blue: number;
}

export interface TagMetadataRule {
  backgroundColor: TagColor;
  blurContent: boolean;
}

export interface TagsSettingValue {
  tags: Record<string, TagMetadataRule | Record<string, unknown>>;
}

export const DEFAULT_TAGS_SETTING_NAME = normalizeInstanceSettingName("TAGS");
export const DEFAULT_TAGS_APPLIED_SETTING_NAME = "cfmemos/default_tags_v1_applied";

export const DEFAULT_PKM_TAG_NAMES = [
  "日常",
  "灵感",
  "待办",
  "资料",
  "技术",
  "项目",
  "工作",
  "财务",
  "家族",
  "家庭",
  "健康",
  "旅行",
] as const;

export type DefaultPkmTagName = (typeof DEFAULT_PKM_TAG_NAMES)[number];

export const DEFAULT_PKM_SECONDARY_TAGS_BY_ROOT: Record<DefaultPkmTagName, readonly string[]> = {
  日常: ["随笔", "生活感悟", "个人见闻", "购物", "美食烹饪", "影音娱乐", "阅读", "社交", "兴趣爱好", "回忆", "汽车"],
  灵感: ["产品创意", "功能设计", "商业构想", "内容创作", "设计创意", "技术构想", "生活创意", "写作构思"],
  待办: ["个人事务", "采购计划", "工作事项", "家庭事务", "项目任务", "财务处理", "学习计划", "联系沟通"],
  资料: [
    "历史",
    "法律",
    "政策",
    "地理",
    "经济",
    "政治",
    "文学",
    "哲学",
    "教育",
    "语言",
    "文化",
    "自然科学",
    "社会科学",
    "百科常识",
    "书摘",
    "新闻资讯",
    "资源收藏",
  ],
  技术: [
    "Cloudflare",
    "AI工具",
    "前端开发",
    "后端开发",
    "桌面开发",
    "移动开发",
    "数据库",
    "网络技术",
    "网络安全",
    "Linux",
    "Windows",
    "OpenWrt",
    "Sing-box",
    "Docker",
    "Git",
    "TypeScript",
    "Python",
    "CSharp",
    "CAD",
    "运维部署",
    "架构设计",
    "效率软件",
    "硬件设备",
  ],
  项目: ["谱匠", "Omnia", "Memos", "万象收银", "云族谱", "PixShell", "导航页"],
  工作: [
    "通信设计",
    "门店经营",
    "项目管理",
    "客户管理",
    "团队管理",
    "会议纪要",
    "汇报总结",
    "行业动态",
    "市场营销",
    "供应链",
    "商品管理",
    "商业合作",
  ],
  财务: ["投资理财", "消费", "收支记账", "预算", "经营成本", "税务", "保险", "资产管理", "银行业务", "债务管理"],
  家族: ["族谱", "迁徙历史", "人物传记", "宗族文献", "口述历史", "老宅故土", "世系考据", "家风家训", "宗祠", "祭祀", "家族事务"],
  家庭: ["房屋设计", "房屋建设", "装修", "家居", "子女教育", "亲子关系", "家务", "亲友往来", "宠物", "家庭活动", "家用电器"],
  健康: ["饮食营养", "运动健身", "睡眠", "体检", "疾病", "就医记录", "药品", "中医中药", "心理健康", "体重管理", "养生", "个人护理"],
  旅行: ["旅行攻略", "自然风光", "人文景观", "历史古迹", "自驾游", "交通出行", "住宿", "地方美食", "旅行见闻"],
} as const;

export const DEFAULT_PKM_SECONDARY_TAGS: readonly string[] = DEFAULT_PKM_TAG_NAMES.flatMap((root) =>
  DEFAULT_PKM_SECONDARY_TAGS_BY_ROOT[root].map((sub) => `${root}/${sub}`),
);

export const DEFAULT_PKM_SECONDARY_TAG_SET = new Set<string>(DEFAULT_PKM_SECONDARY_TAGS);

export interface PkmCategorySpec {
  name: DefaultPkmTagName;
  basis: string;
  granularityExamples: readonly string[];
}

export const PKM_CATEGORY_SPECS: readonly PkmCategorySpec[] = [
  { name: "日常", basis: "生活场景", granularityExamples: ["随笔", "生活感悟", "购物"] },
  { name: "灵感", basis: "创意方向", granularityExamples: ["产品创意", "商业构想", "功能设计"] },
  { name: "待办", basis: "事务类别", granularityExamples: ["个人事务", "采购计划"] },
  { name: "资料", basis: "知识领域", granularityExamples: ["历史", "法律", "政策", "地理"] },
  { name: "技术", basis: "技术领域或独立技术产品", granularityExamples: ["Cloudflare", "网络技术", "AI工具"] },
  { name: "项目", basis: "独立项目名称", granularityExamples: ["谱匠", "Omnia", "Memos"] },
  { name: "工作", basis: "职业或经营领域", granularityExamples: ["通信设计", "门店经营"] },
  { name: "财务", basis: "财务活动类型", granularityExamples: ["投资理财", "消费", "经营成本"] },
  { name: "家族", basis: "家族研究方向", granularityExamples: ["族谱", "迁徙历史", "人物传记"] },
  { name: "家庭", basis: "家庭事务类型", granularityExamples: ["房屋设计", "子女教育", "家居"] },
  { name: "健康", basis: "健康知识领域", granularityExamples: ["饮食营养", "运动健身", "个人护理"] },
  { name: "旅行", basis: "旅行主题", granularityExamples: ["自然风光", "人文景观", "旅行攻略"] },
] as const;

export const PKM_CATEGORY_BOUNDARIES: readonly string[] = [
  "技术 vs 项目：通用技术原理、语言、云产品归「技术」（如 技术/Cloudflare）；自己推进的独立工程实体及功能研发归「项目」（如 项目/Memos）。",
  "日常 vs 财务：普通生活消费体验与日常记录归「日常」；资产配置、投资、预算、账目与经营成本核算归「财务」。",
  "工作 vs 项目：职业职责、客户沟通、门店日常经营归「工作」；有独立名称的研发或创作项目归「项目」。",
  "家族 vs 家庭：祖辈宗族、族谱、迁徙历史归「家族」；小家庭装修、家居、育儿等事务归「家庭」。",
  "资料 vs 技术：历史、法律、政策、地理等非技术知识归档归「资料」；工程技术与开发工具归「技术」。",
];

export const DEFAULT_PKM_TAG_SET = new Set<string>(DEFAULT_PKM_TAG_NAMES);

function rgbToColor(red: number, green: number, blue: number): TagColor {
  return {
    red: red / 255,
    green: green / 255,
    blue: blue / 255,
  };
}

export const DEFAULT_TAG_METADATA_RULES: ReadonlyArray<readonly [string, TagMetadataRule]> = [
  ["^(日常|灵感|资料)$", { backgroundColor: rgbToColor(0x00, 0x80, 0xff), blurContent: false }],
  ["^(待办)$", { backgroundColor: rgbToColor(0xff, 0x80, 0x00), blurContent: false }],
  ["^(技术|项目|工作|财务)$", { backgroundColor: rgbToColor(0x00, 0xcc, 0x66), blurContent: false }],
  ["^(家族|家庭|健康|旅行)$", { backgroundColor: rgbToColor(0x8b, 0x5c, 0xf6), blurContent: false }],
];

const CANONICAL_TAG_PATTERNS = new Set(DEFAULT_TAG_METADATA_RULES.map(([pattern]) => pattern));

export function isInternalSystemSettingName(name: string): boolean {
  const normalized = normalizeInstanceSettingName(name);
  return name === DEFAULT_TAGS_APPLIED_SETTING_NAME || normalized === normalizeInstanceSettingName(DEFAULT_TAGS_APPLIED_SETTING_NAME);
}

function isLegacyDefaultTagRule(pattern: string, rawMeta: unknown): boolean {
  if (!rawMeta || typeof rawMeta !== "object") {
    return false;
  }
  const blurContent = Boolean((rawMeta as { blurContent?: unknown }).blurContent);
  if (blurContent) {
    return false;
  }
  if (CANONICAL_TAG_PATTERNS.has(pattern)) {
    return false;
  }

  let body = pattern.trim();
  if (body.startsWith("^")) body = body.slice(1);
  if (body.endsWith("$")) body = body.slice(0, -1);
  if (body.startsWith("(?:") && body.endsWith(")")) {
    body = body.slice(3, -1);
  } else if (body.startsWith("(") && body.endsWith(")")) {
    body = body.slice(1, -1);
  }

  const hasEscapedPipe = body.includes("\\|");
  const normalizedSeparators = body.replaceAll("\\|", "|");
  const parts = normalizedSeparators.split("|").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !DEFAULT_PKM_TAG_SET.has(part))) {
    return false;
  }

  // Only treat multi-tag alternations or broken `\|` preset patterns as legacy default rules
  // so an explicit single-tag custom rule like `日常` with a custom color is preserved.
  return hasEscapedPipe || parts.length >= 2;
}

function parseTagsSetting(rawValue: string | undefined): Record<string, unknown> {
  if (!rawValue) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawValue) as { tags?: unknown };
    if (parsed && typeof parsed === "object" && parsed.tags && typeof parsed.tags === "object" && !Array.isArray(parsed.tags)) {
      return { ...(parsed.tags as Record<string, unknown>) };
    }
  } catch {
    // Malformed legacy JSON falls back to an empty rules map so defaults can still initialize cleanly.
  }
  return {};
}

function createCanonicalDefaultTagsMap(): Record<string, TagMetadataRule> {
  return Object.fromEntries(DEFAULT_TAG_METADATA_RULES.map(([pattern, meta]) => [pattern, meta]));
}

export async function ensureDefaultTagsSetting(db: D1Database, cache?: KVNamespace): Promise<boolean> {
  const marker = await getSystemSetting(db, DEFAULT_TAGS_APPLIED_SETTING_NAME);
  if (marker?.value === "1") {
    return false;
  }

  const existingSetting = await getInstanceSetting(db, "TAGS");
  const existingTags = parseTagsSetting(existingSetting?.value);
  const nextTags: Record<string, unknown> = {};

  for (const [pattern, meta] of Object.entries(existingTags)) {
    if (!isLegacyDefaultTagRule(pattern, meta)) {
      nextTags[pattern] = meta;
    }
  }

  for (const [pattern, meta] of DEFAULT_TAG_METADATA_RULES) {
    if (!(pattern in nextTags)) {
      nextTags[pattern] = meta;
    }
  }

  const hasExistingEntries = Object.keys(existingTags).length > 0;
  const serializedNext = JSON.stringify({ tags: hasExistingEntries ? nextTags : createCanonicalDefaultTagsMap() });
  const serializedCurrent = existingSetting?.value ?? "";

  if (!existingSetting || serializedCurrent !== serializedNext) {
    await setSystemSetting(db, DEFAULT_TAGS_SETTING_NAME, serializedNext);
    await deleteCachedKeys(cache, [
      "instance:settings",
      `instance:setting:${DEFAULT_TAGS_SETTING_NAME}`,
      "instance:setting:TAGS",
    ]);
  }

  await setSystemSetting(
    db,
    DEFAULT_TAGS_APPLIED_SETTING_NAME,
    "1",
    "Marks one-time initialization of built-in PKM default tag metadata rules",
  );

  return !existingSetting || serializedCurrent !== serializedNext;
}
