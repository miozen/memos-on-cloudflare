import type React from "react";

export interface MemoContentProps {
  content: string;
  compact?: boolean;
  hideTags?: boolean;
  onCompactModeChange?: (isCollapsible: boolean) => void;
  className?: string;
  contentClassName?: string;
  onClick?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
}

export type ContentCompactView = "ALL" | "SNIPPET";
