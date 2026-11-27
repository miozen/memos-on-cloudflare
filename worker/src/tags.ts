const CODE_OR_LINK_SEGMENT_REGEX =
  /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`|\[[^\]]*\]\([^)\n]+\)|https?:\/\/[^\s)]+/g;

const TAG_CHAR_REGEX = /[\p{L}\p{N}\p{S}_\-/&]/u;
const TAG_SEGMENT_START_REGEX = /[\p{L}\p{N}]/u;
const HEX_COLOR_BODY_REGEX = /^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const MAX_TAG_LENGTH = 100;

interface TextSpan {
  start: number;
  end: number;
  tag: string;
}

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

function scanTagsInPlainSegment(segment: string, offset: number): TextSpan[] {
  const spans: TextSpan[] = [];
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

function collectSafeTagSpans(content: string): TextSpan[] {
  const spans: TextSpan[] = [];
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

export function extractMemoTags(content: string): string[] {
  const seen = new Set<string>();
  for (const span of collectSafeTagSpans(content)) {
    seen.add(span.tag);
  }
  return [...seen];
}

export function replaceMemoTagInContent(content: string, oldTag: string, newTag: string | null): string {
  const spans = collectSafeTagSpans(content).filter((span) => span.tag === oldTag);
  if (spans.length === 0) {
    return content;
  }

  let result = "";
  let cursor = 0;

  for (const span of spans) {
    result += content.slice(cursor, span.start);
    if (newTag !== null) {
      result += `#${newTag}`;
      cursor = span.end;
    } else {
      let nextCursor = span.end;
      if ((result.endsWith(" ") || result.endsWith("\t") || result === "" || result.endsWith("\n")) && content[nextCursor] === " ") {
        nextCursor++;
      } else if (result.endsWith(" ") && (nextCursor >= content.length || content[nextCursor] === "\n")) {
        result = result.slice(0, -1);
      }
      cursor = nextCursor;
    }
  }

  result += content.slice(cursor);
  return result;
}
