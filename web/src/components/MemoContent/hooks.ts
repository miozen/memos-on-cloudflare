import { useCallback, useEffect, useRef, useState } from "react";
import { COMPACT_STATES, getMaxDisplayHeight } from "./constants";
import type { ContentCompactView } from "./types";

export const useCompactMode = (enabled: boolean) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<ContentCompactView | undefined>(undefined);

  useEffect(() => {
    if (!enabled) {
      setMode(undefined);
      return;
    }

    const element = containerRef.current;
    if (!element) return;

    const evaluate = () => {
      const maxHeight = getMaxDisplayHeight();
      const measuredHeight = Math.max(element.scrollHeight, element.getBoundingClientRect().height);
      setMode((prev) => {
        if (prev === undefined) {
          return measuredHeight > maxHeight ? "ALL" : undefined;
        }
        // Only un-collapse if scrollHeight genuinely shrunk within maxHeight (avoids false folds when tags move outside).
        if (element.scrollHeight > 0 && element.scrollHeight <= maxHeight) {
          return undefined;
        }
        return prev;
      });
    };

    evaluate();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", evaluate);
      return () => window.removeEventListener("resize", evaluate);
    }

    const observer = new ResizeObserver(evaluate);
    observer.observe(element);
    window.addEventListener("resize", evaluate);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", evaluate);
    };
  }, [enabled]);

  const toggle = useCallback(() => {
    if (!mode) return;
    setMode(COMPACT_STATES[mode].next);
  }, [mode]);

  return { containerRef, mode, toggle };
};

export const useCompactLabel = (mode: ContentCompactView | undefined, t: (key: string) => string): string => {
  if (!mode) return "";
  return t(COMPACT_STATES[mode].textKey);
};
