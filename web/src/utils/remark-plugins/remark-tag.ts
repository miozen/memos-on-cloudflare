import type { Root, Text } from "mdast";
import type { Node as UnistNode, Parent as UnistParent } from "unist";
import { visit } from "unist-util-visit";
import type { TagNode, TagNodeData } from "@/types/markdown";

export interface RemarkTagOptions {
  hideTags?: boolean;
}

const MAX_TAG_LENGTH = 100;

function isTagChar(char: string): boolean {
  if (/\p{L}/u.test(char)) {
    return true;
  }

  if (/\p{N}/u.test(char)) {
    return true;
  }

  if (/\p{S}/u.test(char)) {
    return true;
  }

  return char === "_" || char === "-" || char === "/" || char === "&";
}

function parseTagsFromText(text: string): Array<{ type: "text"; value: string } | { type: "tag"; value: string }> {
  const segments: Array<{ type: "text"; value: string } | { type: "tag"; value: string }> = [];

  const chars = [...text];
  let i = 0;

  while (i < chars.length) {
    if (chars[i] === "#" && i + 1 < chars.length && isTagChar(chars[i + 1])) {
      const prevChar = i > 0 ? chars[i - 1] : "";
      const nextChar = i + 1 < chars.length ? chars[i + 1] : "";

      if (prevChar === "#" || nextChar === "#" || nextChar === " ") {
        segments.push({ type: "text", value: chars[i] });
        i++;
        continue;
      }

      let j = i + 1;
      while (j < chars.length && isTagChar(chars[j])) {
        j++;
      }

      const tagContent = chars.slice(i + 1, j).join("");

      const runeCount = [...tagContent].length;
      if (runeCount > 0 && runeCount <= MAX_TAG_LENGTH) {
        segments.push({ type: "tag", value: tagContent });
        i = j;
        continue;
      }
    }

    let j = i + 1;
    while (j < chars.length && chars[j] !== "#") {
      j++;
    }
    segments.push({ type: "text", value: chars.slice(i, j).join("") });
    i = j;
  }

  return segments;
}

function createTagNode(tagValue: string): TagNode {
  const data: TagNodeData = {
    hName: "span",
    hProperties: {
      className: "tag",
      "data-tag": tagValue,
    },
    hChildren: [{ type: "text", value: `#${tagValue}` }],
  };

  return {
    type: "tagNode",
    value: tagValue,
    data,
  } as TagNode;
}

export function hasNonTagMarkdownContent(content: string): boolean {
  if (!content.trim()) {
    return false;
  }
  return parseTagsFromText(content).some((segment) => segment.type === "text" && segment.value.trim().length > 0);
}

function buildTextWithoutTags(segments: Array<{ type: "text"; value: string } | { type: "tag"; value: string }>): string {
  let result = "";
  let skippedTag = false;

  for (const segment of segments) {
    if (segment.type === "tag") {
      skippedTag = true;
      continue;
    }

    let nextValue = segment.value;
    if (skippedTag) {
      if (result.endsWith(" ") && nextValue.startsWith(" ")) {
        nextValue = nextValue.slice(1);
      } else if (!result && /^[ \t]+/.test(nextValue)) {
        nextValue = nextValue.replace(/^[ \t]+/, "");
      }
      skippedTag = false;
    }
    result += nextValue;
  }

  return skippedTag ? result.replace(/[ \t]+$/, "") : result;
}

function isWhitespaceOrBreak(node: UnistNode | undefined): boolean {
  if (!node) return false;
  if (node.type === "break") return true;
  return node.type === "text" && typeof (node as Text).value === "string" && (node as Text).value.trim() === "";
}

function cleanupParentAfterTagRemoval(parent: UnistParent): void {
  const children = parent.children as UnistNode[];
  const collapsed: UnistNode[] = [];

  for (const child of children) {
    if (child.type === "break" && collapsed[collapsed.length - 1]?.type === "break") {
      continue;
    }
    collapsed.push(child);
  }

  while (collapsed.length > 0 && isWhitespaceOrBreak(collapsed[0])) {
    collapsed.shift();
  }
  while (collapsed.length > 0 && isWhitespaceOrBreak(collapsed[collapsed.length - 1])) {
    collapsed.pop();
  }

  parent.children = collapsed;
}

export const remarkTag = (options?: RemarkTagOptions) => {
  const hideTags = Boolean(options?.hideTags);

  return (tree: Root) => {
    const parentsWithRemovedTags = new Set<UnistParent>();

    visit(tree, (node, index, parent) => {
      if (node.type !== "text" || !parent || index === null) return;

      const textNode = node as Text;
      const text = textNode.value;
      const segments = parseTagsFromText(text);

      if (segments.every((seg) => seg.type === "text")) {
        return;
      }

      if (hideTags) {
        parentsWithRemovedTags.add(parent as UnistParent);
        const strippedText = buildTextWithoutTags(segments);
        if (typeof index === "number" && parent) {
          if (strippedText) {
            (parent.children as UnistNode[]).splice(index, 1, {
              type: "text",
              value: strippedText,
            } as Text);
          } else {
            (parent.children as UnistNode[]).splice(index, 1);
            return index;
          }
        }
        return;
      }

      const newNodes = segments.map((segment) => {
        if (segment.type === "tag") {
          return createTagNode(segment.value);
        }
        return {
          type: "text",
          value: segment.value,
        } as Text;
      });

      if (typeof index === "number" && parent) {
        (parent.children as UnistNode[]).splice(index, 1, ...(newNodes as UnistNode[]));
      }
    });

    if (hideTags && parentsWithRemovedTags.size > 0) {
      for (const parent of parentsWithRemovedTags) {
        cleanupParentAfterTagRemoval(parent);
      }
      visit(tree, (node, index, parent) => {
        if (
          parent &&
          typeof index === "number" &&
          node.type === "paragraph" &&
          parentsWithRemovedTags.has(node as UnistParent) &&
          (node as UnistParent).children.length === 0
        ) {
          (parent.children as UnistNode[]).splice(index, 1);
          return index;
        }
      });
    }
  };
};
