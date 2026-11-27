import { useMemo } from "react";
import { matchPath } from "react-router-dom";
import OverflowTip from "@/components/kit/OverflowTip";
import { useTagCounts } from "@/hooks/useUserQueries";
import { DEFAULT_PKM_PRESET_SECONDARY_TAGS, DEFAULT_PKM_TAG_NAMES } from "@/lib/default-tags";
import { Routes } from "@/router";
import type { TagSuggestionsProps } from "../types";
import { SuggestionsPopup } from "./SuggestionsPopup";
import { useSuggestions } from "./useSuggestions";

export const MAX_TAG_AUTOCOMPLETE_RESULTS = 30;

export interface TagAutocompletePool {
  usedTags: string[];
  allTags: string[];
  usedLowerSet: Set<string>;
}

export function buildTagAutocompletePool(tagCount: Record<string, number>): TagAutocompletePool {
  const usedTags = Object.entries(tagCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);

  const seenLower = new Set(usedTags.map((tag) => tag.toLowerCase()));
  const primaryExtras: string[] = [];
  for (const tag of DEFAULT_PKM_TAG_NAMES) {
    const lower = tag.toLowerCase();
    if (!seenLower.has(lower)) {
      seenLower.add(lower);
      primaryExtras.push(tag);
    }
  }

  const presetSecondaryExtras: string[] = [];
  for (const tag of DEFAULT_PKM_PRESET_SECONDARY_TAGS) {
    const lower = tag.toLowerCase();
    if (!seenLower.has(lower)) {
      seenLower.add(lower);
      presetSecondaryExtras.push(tag);
    }
  }

  return {
    usedTags,
    allTags: [...usedTags, ...primaryExtras, ...presetSecondaryExtras],
    usedLowerSet: new Set(usedTags.map((tag) => tag.toLowerCase())),
  };
}

export function filterTagSuggestions(pool: TagAutocompletePool, rawQuery: string): string[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    // Bare `#` shows only the 12 primary categories without dumping all secondary tags.
    return [...DEFAULT_PKM_TAG_NAMES];
  }

  const scored: Array<{ tag: string; tier: number; isUsed: boolean; index: number }> = [];
  for (let i = 0; i < pool.allTags.length; i++) {
    const tag = pool.allTags[i];
    const lower = tag.toLowerCase();
    let tier = -1;
    if (lower === query) {
      tier = 0;
    } else if (lower.startsWith(query)) {
      tier = 1;
    } else if (lower.includes(query)) {
      tier = 2;
    }
    if (tier !== -1) {
      scored.push({
        tag,
        tier,
        isUsed: pool.usedLowerSet.has(lower),
        index: i,
      });
    }
  }

  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.isUsed !== b.isUsed) return a.isUsed ? -1 : 1;
    return a.index - b.index;
  });

  return scored.slice(0, MAX_TAG_AUTOCOMPLETE_RESULTS).map((entry) => entry.tag);
}

export default function TagSuggestions({ editorRef, editorActions }: TagSuggestionsProps) {
  // On explore page, show all users' tags; otherwise show current user's tags
  const isExplorePage = Boolean(matchPath(Routes.EXPLORE, window.location.pathname));
  const { data: tagCount = {} } = useTagCounts(!isExplorePage);

  const pool = useMemo(() => buildTagAutocompletePool(tagCount as Record<string, number>), [tagCount]);

  const { position, suggestions, selectedIndex, isVisible, handleItemSelect } = useSuggestions({
    editorRef,
    editorActions,
    triggerChar: "#",
    items: pool.allTags,
    filterItems: (_items, query) => filterTagSuggestions(pool, query),
    onAutocomplete: (tag, word, index, actions) => {
      actions.removeText(index, word.length);
      actions.insertText(`#${tag} `);
    },
  });

  if (!isVisible || !position) return null;

  return (
    <SuggestionsPopup
      position={position}
      suggestions={suggestions}
      selectedIndex={selectedIndex}
      onItemSelect={handleItemSelect}
      getItemKey={(tag) => tag}
      renderItem={(tag) => (
        <OverflowTip>
          <span className="text-muted-foreground mr-1">#</span>
          {tag}
        </OverflowTip>
      )}
    />
  );
}
