import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Position } from "./useSuggestions";

interface SuggestionsPopupProps<T> {
  position: Position;
  suggestions: T[];
  selectedIndex: number;
  onItemSelect: (item: T) => void;
  renderItem: (item: T, isSelected: boolean) => ReactNode;
  getItemKey: (item: T, index: number) => string;
}

const POPUP_STYLES = {
  container:
    "z-20 absolute p-1 mt-1 -ml-2 min-w-44 max-w-[min(18rem,calc(100%-0.5rem))] max-h-60 rounded border bg-popover text-popover-foreground shadow-lg font-mono flex flex-col overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]",
  item: "rounded p-1 px-2 w-full min-w-0 text-sm cursor-pointer transition-colors select-none hover:bg-accent hover:text-accent-foreground",
};

export function SuggestionsPopup<T>({
  position,
  suggestions,
  selectedIndex,
  onItemSelect,
  renderItem,
  getItemKey,
}: SuggestionsPopupProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedItemRef = useRef<HTMLDivElement>(null);
  const [clampedLeft, setClampedLeft] = useState(position.left);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const parent = container?.offsetParent as HTMLElement | null;
    if (!container || !parent || parent.clientWidth <= 0 || container.offsetWidth <= 0) {
      setClampedLeft(position.left);
      return;
    }

    const marginLeft = Number.parseFloat(getComputedStyle(container).marginLeft) || 0;
    const maxLeft = Math.max(0, parent.clientWidth - container.offsetWidth - marginLeft);
    setClampedLeft(Math.max(0, Math.min(position.left, maxLeft)));
  }, [position.left, suggestions.length]);

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedIndex]);

  return (
    <div ref={containerRef} className={POPUP_STYLES.container} style={{ left: clampedLeft, top: position.top + position.height }}>
      {suggestions.map((item, i) => (
        <div
          key={getItemKey(item, i)}
          ref={i === selectedIndex ? selectedItemRef : null}
          onMouseDown={() => onItemSelect(item)}
          className={cn(POPUP_STYLES.item, i === selectedIndex && "bg-accent text-accent-foreground")}
        >
          {renderItem(item, i === selectedIndex)}
        </div>
      ))}
    </div>
  );
}
