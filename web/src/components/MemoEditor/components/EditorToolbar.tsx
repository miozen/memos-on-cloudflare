import { LoaderIcon, SparklesIcon } from "lucide-react";
import { type FC, useEffect, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { aiServiceClient } from "@/connect";
import { useInstance } from "@/contexts/InstanceContext";
import { useTranslate } from "@/utils/i18n";
import { validationService } from "../services";
import { useEditorContext } from "../state";
import InsertMenu from "../Toolbar/InsertMenu";
import VisibilitySelector from "../Toolbar/VisibilitySelector";
import type { EditorToolbarProps } from "../types";

interface SuggestedTagChip {
  tag: string;
  mode: "reuse" | "new" | "primary";
}

export const EditorToolbar: FC<EditorToolbarProps> = ({ onSave, onCancel, memoName, onAudioRecorderClick, onInsertSuggestedTag }) => {
  const t = useTranslate();
  const { state, actions, dispatch } = useEditorContext();
  const { memoRelatedSetting } = useInstance();
  const [isSuggestingTags, setIsSuggestingTags] = useState(false);
  const [suggestedTags, setSuggestedTags] = useState<SuggestedTagChip[]>([]);
  const requestSeqRef = useRef(0);
  const { valid } = validationService.canSave(state, { contentLengthLimit: memoRelatedSetting.contentLengthLimit });

  const isSaving = state.ui.isLoading.saving;

  useEffect(() => {
    requestSeqRef.current++;
    setSuggestedTags([]);
    setIsSuggestingTags(false);
  }, [memoName]);

  useEffect(() => {
    if (!state.content.trim()) {
      requestSeqRef.current++;
      setSuggestedTags([]);
      setIsSuggestingTags(false);
    }
  }, [state.content]);

  useEffect(() => {
    return () => {
      requestSeqRef.current++;
    };
  }, []);

  const handleSuggestTags = async () => {
    const content = state.content.trim();
    if (!content || isSuggestingTags) return;

    const reqId = ++requestSeqRef.current;
    setIsSuggestingTags(true);
    try {
      const result = await aiServiceClient.suggestTags({ content });
      if (requestSeqRef.current !== reqId) {
        return;
      }
      const nextSuggestions: SuggestedTagChip[] =
        Array.isArray(result.suggestions) && result.suggestions.length > 0
          ? result.suggestions
          : result.tags.map((tag) => ({ tag, mode: tag.includes("/") ? "reuse" : "primary" }));

      if (nextSuggestions.length === 0) {
        toast(t("editor.suggest-tags-empty"));
        setSuggestedTags([]);
      } else {
        setSuggestedTags(nextSuggestions);
      }
    } catch {
      if (requestSeqRef.current !== reqId) {
        return;
      }
      toast.error(t("editor.suggest-tags-failed"));
    } finally {
      if (requestSeqRef.current === reqId) {
        setIsSuggestingTags(false);
      }
    }
  };

  const handlePickSuggestedTag = (tag: string) => {
    onInsertSuggestedTag?.(tag);
    setSuggestedTags((prev) => prev.filter((item) => item.tag !== tag));
  };

  const handleLocationChange = (location: typeof state.metadata.location) => {
    dispatch(actions.setMetadata({ location }));
  };

  const handleToggleFocusMode = () => {
    dispatch(actions.toggleFocusMode());
  };

  const handleVisibilityChange = (visibility: typeof state.metadata.visibility) => {
    dispatch(actions.setMetadata({ visibility }));
  };

  return (
    <div className="w-full flex flex-col gap-1.5 mb-2">
      {suggestedTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{t("editor.suggested-tags-label")}</span>
          {suggestedTags.map((item) => (
            <button
              key={item.tag}
              type="button"
              onClick={() => handlePickSuggestedTag(item.tag)}
              className="inline-flex items-center rounded-full border border-border bg-accent/50 px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-accent"
            >
              <span>{`+ #${item.tag}`}</span>
              {item.mode === "new" && (
                <span className="ml-1 rounded bg-primary/15 px-1 py-px text-[10px] font-medium text-primary">
                  {t("editor.suggested-tag-new")}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <div className="w-full flex flex-row justify-between items-center">
        <div className="flex flex-row justify-start items-center gap-1">
          <InsertMenu
            isUploading={state.ui.isLoading.uploading}
            location={state.metadata.location}
            onLocationChange={handleLocationChange}
            onToggleFocusMode={handleToggleFocusMode}
            memoName={memoName}
            onAudioRecorderClick={onAudioRecorderClick}
          />
          {onInsertSuggestedTag && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-muted-foreground hover:text-foreground"
              disabled={!state.content.trim() || isSuggestingTags}
              onClick={handleSuggestTags}
              title={t("editor.suggest-tags")}
              aria-label={t("editor.suggest-tags")}
            >
              {isSuggestingTags ? <LoaderIcon className="size-4 animate-spin" /> : <SparklesIcon className="size-4" />}
            </Button>
          )}
        </div>

        <div className="flex flex-row justify-end items-center gap-2">
          <VisibilitySelector value={state.metadata.visibility} onChange={handleVisibilityChange} />

          {onCancel && (
            <Button variant="ghost" onClick={onCancel} disabled={isSaving}>
              {t("common.cancel")}
            </Button>
          )}

          <Button onClick={onSave} disabled={!valid || isSaving}>
            {isSaving ? t("editor.saving") : t("editor.save")}
          </Button>
        </div>
      </div>
    </div>
  );
};
