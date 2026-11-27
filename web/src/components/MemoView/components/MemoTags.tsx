import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { Tag } from "../../MemoContent/Tag";

interface MemoTagsProps {
  tags?: readonly string[];
  className?: string;
}

const MemoTags: React.FC<MemoTagsProps> = ({ tags, className }) => {
  const uniqueTags = useMemo(() => Array.from(new Set((tags ?? []).filter(Boolean))), [tags]);

  if (uniqueTags.length === 0) {
    return null;
  }

  return (
    <div className={cn("w-full flex flex-wrap items-center gap-1.5", className)} data-testid="memo-tags">
      {uniqueTags.map((tag) => (
        <Tag key={tag} data-tag={tag}>
          #{tag}
        </Tag>
      ))}
    </div>
  );
};

export default MemoTags;
