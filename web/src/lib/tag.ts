import { create } from "@bufbuild/protobuf";
import {
  type InstanceSetting_TagMetadata,
  InstanceSetting_TagMetadataSchema,
  type InstanceSetting_TagsSetting,
} from "@/types/proto/api/v1/instance_service_pb";

// Cache compiled regexes to avoid re-compiling on every tag render.
const compiledPatternCache = new Map<string, RegExp | null>();

const CODE_OR_LINK_SEGMENT_REGEX =
  /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`|\[[^\]]*\]\([^)\n]+\)|https?:\/\/[^\s)]+/g;
const TAG_CHAR_REGEX = /[\p{L}\p{N}\p{S}_\-/&]/u;
const TAG_SEGMENT_START_REGEX = /[\p{L}\p{N}]/u;
const HEX_COLOR_BODY_REGEX = /^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const MAX_TAG_LENGTH = 100;

interface TextTagSpan {
  start: number;
  end: number;
  tag: string;
}

const getCompiledPattern = (pattern: string): RegExp | null => {
  if (compiledPatternCache.has(pattern)) {
    return compiledPatternCache.get(pattern)!;
  }
  let re: RegExp | null = null;
  try {
    re = new RegExp(`^(?:${pattern})$`);
  } catch {
    // Invalid pattern — cache as null so we skip it without retrying.
  }
  compiledPatternCache.set(pattern, re);
  return re;
};

const findDirectTagMetadata = (tag: string, tagsSetting: InstanceSetting_TagsSetting): InstanceSetting_TagMetadata | undefined => {
  const tags = tagsSetting?.tags;
  if (!tags) return undefined;

  // Fast path: exact match.
  if (tags[tag]) {
    return tags[tag];
  }

  // Regex path: treat each key as an anchored pattern.
  for (const [pattern, metadata] of Object.entries(tags)) {
    const re = getCompiledPattern(pattern);
    if (re?.test(tag)) {
      return metadata;
    }
  }

  return undefined;
};

/**
 * Finds the matching TagMetadata for a given tag name.
 * Secondary tags (e.g. `技术/Cloudflare`) inherit the parent tag's backgroundColor
 * when they have no color configured, but never inherit non-color metadata such as blurContent.
 */
export const findTagMetadata = (tag: string, tagsSetting: InstanceSetting_TagsSetting): InstanceSetting_TagMetadata | undefined => {
  const direct = findDirectTagMetadata(tag, tagsSetting);
  if (!tag.includes("/")) {
    return direct;
  }

  const parentTag = tag.split("/")[0];
  const parentColor = parentTag ? findDirectTagMetadata(parentTag, tagsSetting)?.backgroundColor : undefined;

  if (direct) {
    if (direct.backgroundColor || !parentColor) {
      return direct;
    }
    return create(InstanceSetting_TagMetadataSchema, {
      backgroundColor: parentColor,
      blurContent: direct.blurContent,
    });
  }

  if (!parentColor) {
    return undefined;
  }

  return create(InstanceSetting_TagMetadataSchema, {
    backgroundColor: parentColor,
    blurContent: false,
  });
};

/**
 * Returns true if the given string is a valid, ReDoS-safe JavaScript regex pattern.
 *
 * Rejects patterns with nested quantifiers (e.g. `(a+)+`) which can cause
 * catastrophic backtracking in JavaScript's regex engine.
 */
export const isValidTagPattern = (pattern: string): boolean => {
  if (!pattern) return false;
  try {
    new RegExp(pattern);
  } catch {
    return false;
  }
  // Reject nested quantifiers: a quantified group whose body itself contains
  // a quantifier — the classic ReDoS shape e.g. (a+)+, (a*b?)+, (x|y+)+.
  if (/\((?:[^()]*[*+?{][^()]*)\)[*+?{]/.test(pattern)) {
    return false;
  }
  return true;
};

function isTagBoundaryBefore(char: string): boolean {
  if (!char) return true;
  if (/\s/.test(char)) return true;
  return !TAG_CHAR_REGEX.test(char) && char !== "#" && char !== "=" && char !== "?";
}

function isValidTagText(tag: string): boolean {
  if (!tag || tag.length > MAX_TAG_LENGTH || HEX_COLOR_BODY_REGEX.test(tag)) {
    return false;
  }
  const segments = tag.split("/");
  return segments.every((segment) => segment.length > 0 && TAG_SEGMENT_START_REGEX.test(segment[0]));
}

function scanTagsInPlainSegment(segment: string, offset: number): TextTagSpan[] {
  const spans: TextTagSpan[] = [];
  const chars = [...segment];
  const byteOffsets: number[] = [0];
  for (let idx = 0; idx < chars.length; idx++) {
    byteOffsets.push(byteOffsets[idx] + chars[idx].length);
  }

  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === "#" && i + 1 < chars.length && TAG_CHAR_REGEX.test(chars[i + 1])) {
      const prevChar = i > 0 ? chars[i - 1] : "";
      const nextChar = chars[i + 1];
      if (isTagBoundaryBefore(prevChar) && nextChar !== "#") {
        let j = i + 1;
        while (j < chars.length && TAG_CHAR_REGEX.test(chars[j])) {
          j++;
        }
        const tag = chars.slice(i + 1, j).join("");
        const runeLength = j - (i + 1);
        if (runeLength > 0 && runeLength <= MAX_TAG_LENGTH && isValidTagText(tag)) {
          spans.push({
            start: offset + byteOffsets[i],
            end: offset + byteOffsets[j],
            tag,
          });
          i = j;
          continue;
        }
      }
    }
    i++;
  }
  return spans;
}

export function collectSafeTagSpans(content: string): TextTagSpan[] {
  const spans: TextTagSpan[] = [];
  let cursor = 0;
  CODE_OR_LINK_SEGMENT_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CODE_OR_LINK_SEGMENT_REGEX.exec(content)) !== null) {
    if (match.index > cursor) {
      spans.push(...scanTagsInPlainSegment(content.slice(cursor, match.index), cursor));
    }
    cursor = match.index + match[0].length;
  }

  if (cursor < content.length) {
    spans.push(...scanTagsInPlainSegment(content.slice(cursor), cursor));
  }

  return spans;
}

/**
 * Applies an accepted suggested tag to memo content:
 * - Skips if the tag (case-insensitive) is already present.
 * - If accepting a secondary tag (`root/sub`) while a standalone primary `#root`
 *   already exists outside code/links, upgrades `#root` in place to `#root/sub`.
 * - Otherwise appends `#tag ` cleanly at the end.
 */
export function applySuggestedTagToContent(content: string, suggestedTag: string): string {
  const spans = collectSafeTagSpans(content);
  const suggestedLower = suggestedTag.toLowerCase();
  if (spans.some((span) => span.tag.toLowerCase() === suggestedLower)) {
    return content;
  }

  if (suggestedTag.includes("/")) {
    const primaryRoot = suggestedTag.split("/")[0];
    const matchingPrimarySpans = spans.filter((span) => span.tag === primaryRoot);
    if (matchingPrimarySpans.length > 0) {
      let result = "";
      let cursor = 0;
      matchingPrimarySpans.forEach((span, index) => {
        result += content.slice(cursor, span.start);
        if (index === 0) {
          result += `#${suggestedTag}`;
          cursor = span.end;
        } else {
          let nextCursor = span.end;
          if (
            (result.endsWith(" ") || result.endsWith("\t") || result === "" || result.endsWith("\n")) &&
            content[nextCursor] === " "
          ) {
            nextCursor++;
          } else if (result.endsWith(" ") && (nextCursor >= content.length || content[nextCursor] === "\n")) {
            result = result.slice(0, -1);
          }
          cursor = nextCursor;
        }
      });
      result += content.slice(cursor);
      return result;
    }
  }

  const prefix = content.length === 0 || /[\s\n]$/.test(content) ? "" : " ";
  return `${content}${prefix}#${suggestedTag} `;
}
