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

const DEFAULT_PKM_TAG_SET = new Set<string>(DEFAULT_PKM_TAG_NAMES);

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
