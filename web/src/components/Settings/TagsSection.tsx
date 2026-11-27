import { create } from "@bufbuild/protobuf";
import { useQueryClient } from "@tanstack/react-query";
import { isEqual } from "lodash-es";
import { ArrowRightIcon, EyeOffIcon, PaletteIcon, PlusIcon, TagIcon, TrashIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "react-hot-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { memoServiceClient } from "@/connect";
import { useInstance } from "@/contexts/InstanceContext";
import { memoKeys } from "@/hooks/useMemoQueries";
import { userKeys, useTagCounts } from "@/hooks/useUserQueries";
import { colorToHex } from "@/lib/color";
import { DEFAULT_PKM_TAGS } from "@/lib/default-tags";
import { findTagMetadata, isValidTagPattern } from "@/lib/tag";
import { cn } from "@/lib/utils";
import {
  InstanceSetting_Key,
  InstanceSetting_TagMetadataSchema,
  InstanceSetting_TagsSettingSchema,
  InstanceSettingSchema,
} from "@/types/proto/api/v1/instance_service_pb";
import { ColorSchema } from "@/types/proto/google/type/color_pb";
import { useTranslate } from "@/utils/i18n";
import SettingGroup from "./SettingGroup";
import { SettingList, SettingPanel } from "./SettingList";
import SettingSection from "./SettingSection";
import useInstanceSettingUpdater, { buildInstanceSettingName } from "./useInstanceSettingUpdater";

const DEFAULT_TAG_COLOR = "#ffffff";

// Converts a CSS hex string to a google.type.Color message.
const hexToColor = (hex: string) =>
  create(ColorSchema, {
    red: parseInt(hex.slice(1, 3), 16) / 255,
    green: parseInt(hex.slice(3, 5), 16) / 255,
    blue: parseInt(hex.slice(5, 7), 16) / 255,
  });

interface LocalTagMeta {
  color?: string;
  blur: boolean;
}

const toLocalTagMeta = (meta: {
  backgroundColor?: { red?: number; green?: number; blue?: number };
  blurContent: boolean;
}): LocalTagMeta => ({
  color: colorToHex(meta.backgroundColor),
  blur: meta.blurContent,
});

const buildTagsSetting = (localTags: Record<string, LocalTagMeta>) => {
  const tags = Object.fromEntries(
    Object.entries(localTags).map(([name, meta]) => [
      name,
      create(InstanceSetting_TagMetadataSchema, {
        blurContent: meta.blur,
        ...(meta.color ? { backgroundColor: hexToColor(meta.color) } : {}),
      }),
    ]),
  );
  return create(InstanceSetting_TagsSettingSchema, { tags });
};

const TagsSection = () => {
  const t = useTranslate();
  const queryClient = useQueryClient();
  const saveInstanceSetting = useInstanceSettingUpdater();
  const { tagsSetting: originalSetting } = useInstance();
  const { data: tagCounts = {} } = useTagCounts(false);
  const [batchOldTag, setBatchOldTag] = useState("");
  const [batchNewTag, setBatchNewTag] = useState("");
  const [isRenamingTag, setIsRenamingTag] = useState(false);

  // Local state: map of tagName → { color, blur } for editing.
  const [localTags, setLocalTags] = useState<Record<string, LocalTagMeta>>(() =>
    Object.fromEntries(Object.entries(originalSetting.tags).map(([name, meta]) => [name, toLocalTagMeta(meta)])),
  );
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState<string | undefined>(undefined);
  const [newTagBlur, setNewTagBlur] = useState(false);

  // Sync local state when the fetched setting arrives (the fetch is async and
  // completes after mount, so localTags would be empty without this sync).
  useEffect(() => {
    setLocalTags(Object.fromEntries(Object.entries(originalSetting.tags).map(([name, meta]) => [name, toLocalTagMeta(meta)])));
  }, [originalSetting.tags]);

  // All known tag names: union of saved entries and tags used in memos.
  const allKnownTags = useMemo(
    () => Array.from(new Set([...Object.keys(localTags), ...Object.keys(tagCounts)])).sort(),
    [localTags, tagCounts],
  );

  // Only show rows for tags that have metadata configured.
  const configuredEntries = useMemo(
    () =>
      Object.keys(localTags)
        .sort()
        .map((name) => ({ name, count: tagCounts[name] ?? 0 })),
    [localTags, tagCounts],
  );

  const originalMetaMap = useMemo(
    () => Object.fromEntries(Object.entries(originalSetting.tags).map(([name, meta]) => [name, toLocalTagMeta(meta)])),
    [originalSetting.tags],
  );
  const hasChanges = !isEqual(localTags, originalMetaMap);

  const handleColorChange = (tagName: string, hex: string) => {
    setLocalTags((prev) => ({ ...prev, [tagName]: { ...prev[tagName], color: hex } }));
  };

  const handleBlurChange = (tagName: string, blur: boolean) => {
    setLocalTags((prev) => ({ ...prev, [tagName]: { ...prev[tagName], blur } }));
  };

  const handleClearColor = (tagName: string) => {
    setLocalTags((prev) => ({ ...prev, [tagName]: { ...prev[tagName], color: undefined } }));
  };

  const handleRemoveTag = (tagName: string) => {
    setLocalTags((prev) => {
      const next = { ...prev };
      delete next[tagName];
      return next;
    });
  };

  const handleAddTag = () => {
    const name = newTagName.trim();
    if (!name) return;
    if (localTags[name] !== undefined) {
      toast.error(t("setting.tags.tag-already-exists"));
      return;
    }
    if (!isValidTagPattern(name)) {
      toast.error(t("setting.tags.invalid-regex"));
      return;
    }
    setLocalTags((prev) => ({ ...prev, [name]: { color: newTagColor, blur: newTagBlur } }));
    setNewTagName("");
    setNewTagColor(undefined);
    setNewTagBlur(false);
  };

  const previewTagsSetting = useMemo(() => buildTagsSetting(localTags), [localTags]);

  const handleSave = async () => {
    await saveInstanceSetting({
      key: InstanceSetting_Key.TAGS,
      setting: create(InstanceSettingSchema, {
        name: buildInstanceSettingName(InstanceSetting_Key.TAGS),
        value: {
          case: "tagsSetting",
          value: previewTagsSetting,
        },
      }),
      errorContext: "Update tags setting",
    });
  };

  const usedTagNames = useMemo(() => Object.keys(tagCounts).sort(), [tagCounts]);

  const handleBatchRenameTag = async () => {
    const oldTag = batchOldTag.trim().replace(/^#+/, "");
    const nextRaw = batchNewTag.trim().replace(/^#+/, "");
    if (!oldTag || /\s/.test(oldTag) || /\s/.test(nextRaw)) {
      toast.error(t("tag.rename-error-empty"));
      return;
    }
    if (oldTag === nextRaw) {
      toast.error(t("tag.rename-error-repeat"));
      return;
    }

    setIsRenamingTag(true);
    try {
      const result = await memoServiceClient.renameTag({
        oldTag,
        newTag: nextRaw || null,
      });
      toast.success(t("setting.tags.batch-success", { count: result.updatedCount }));
      setBatchOldTag("");
      setBatchNewTag("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: memoKeys.all }),
        queryClient.invalidateQueries({ queryKey: userKeys.stats() }),
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("setting.tags.batch-failed"));
    } finally {
      setIsRenamingTag(false);
    }
  };

  return (
    <SettingSection title={t("setting.tags.label")}>
      <SettingGroup title={t("setting.tags.title")} description={t("setting.tags.description")}>
        <SettingPanel footer={<span className="text-xs text-muted-foreground">{t("setting.tags.tag-pattern-hint")}</span>}>
          <div className="flex flex-col gap-3 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <PlusIcon className="size-3.5" />
                <span>{t("setting.tags.add-rule")}</span>
              </div>
              <Button variant="outline" onClick={handleAddTag} disabled={!newTagName.trim()}>
                <PlusIcon className="w-4 h-4 mr-1.5" />
                {t("common.add")}
              </Button>
            </div>

            <div className="grid gap-2 lg:grid-cols-[minmax(16rem,1fr)_auto_auto] lg:items-center">
              <div className="min-w-0">
                <Input
                  className="font-mono"
                  placeholder={t("setting.tags.tag-name-placeholder")}
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
                  list="known-tags"
                />
                <datalist id="known-tags">
                  {allKnownTags
                    .filter((tag) => !localTags[tag])
                    .map((tag) => (
                      <option key={tag} value={tag} />
                    ))}
                </datalist>
              </div>

              <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2 text-sm text-muted-foreground">
                <PaletteIcon className="size-4" />
                <span>{t("setting.tags.background-color")}</span>
                <input
                  type="color"
                  className="size-6 cursor-pointer rounded border border-border bg-transparent p-0.5"
                  value={newTagColor ?? DEFAULT_TAG_COLOR}
                  onChange={(e) => setNewTagColor(e.target.value)}
                  aria-label={t("setting.tags.background-color")}
                />
                <Button variant="ghost" size="sm" onClick={() => setNewTagColor(undefined)} disabled={!newTagColor} className="h-6 px-1.5">
                  {t("common.clear")}
                </Button>
              </div>

              <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2 text-sm text-muted-foreground">
                <EyeOffIcon className="size-4" />
                <span>{t("setting.tags.blur-content")}</span>
                <Switch checked={newTagBlur} onCheckedChange={setNewTagBlur} />
              </label>
            </div>
          </div>
        </SettingPanel>

        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-medium text-muted-foreground">{t("setting.tags.configured-rules")}</h4>
          <Badge variant="outline" className="rounded-md px-2 py-0 text-xs font-normal">
            {configuredEntries.length}
          </Badge>
        </div>

        <SettingList>
          {configuredEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
              <TagIcon className="size-5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t("setting.tags.no-tags-configured")}</p>
            </div>
          ) : (
            <>
              {configuredEntries.map((row) => (
                <div key={row.name} className="grid gap-3 px-3 py-3 lg:grid-cols-[minmax(12rem,1fr)_auto_auto_auto] lg:items-center">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <TagIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate font-mono text-sm text-foreground">{row.name}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 pl-6 text-xs text-muted-foreground">
                      <span>{t("setting.tags.matching-rule")}</span>
                      <span className="text-border">/</span>
                      <span>{t("setting.tags.used-count", { count: row.count })}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span
                      className={cn("size-5 rounded-md border border-border", !localTags[row.name].color && "bg-background")}
                      style={{ backgroundColor: localTags[row.name].color ?? DEFAULT_TAG_COLOR }}
                      aria-hidden
                    />
                    <input
                      type="color"
                      className="size-8 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
                      value={localTags[row.name].color ?? DEFAULT_TAG_COLOR}
                      onChange={(e) => handleColorChange(row.name, e.target.value)}
                      aria-label={t("setting.tags.background-color")}
                    />
                    <Button variant="ghost" size="sm" onClick={() => handleClearColor(row.name)} disabled={!localTags[row.name].color}>
                      {localTags[row.name].color ?? t("setting.tags.default-color")}
                    </Button>
                  </div>

                  <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <EyeOffIcon className="size-4" />
                    {t("setting.tags.blur-content")}
                    <Switch checked={localTags[row.name].blur} onCheckedChange={(checked) => handleBlurChange(row.name, checked)} />
                  </label>

                  <Button variant="ghost" size="sm" onClick={() => handleRemoveTag(row.name)} aria-label={t("common.delete")}>
                    <TrashIcon className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </>
          )}
        </SettingList>
      </SettingGroup>

      <div className="w-full flex justify-end">
        <Button disabled={!hasChanges} onClick={handleSave}>
          {t("common.save")}
        </Button>
      </div>

      <SettingGroup title={t("setting.tags.batch-title")} description={t("setting.tags.batch-description")} showSeparator>
        <SettingPanel footer={<span className="text-xs text-muted-foreground">{t("setting.tags.batch-hint")}</span>}>
          <div className="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(8rem,1fr)_auto_minmax(8rem,1fr)_auto] sm:items-center">
            <Input
              className="font-mono"
              placeholder={t("tag.old-name")}
              value={batchOldTag}
              onChange={(e) => setBatchOldTag(e.target.value)}
              list="used-tags-list"
            />
            <datalist id="used-tags-list">
              {usedTagNames.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
            <ArrowRightIcon className="hidden size-4 text-muted-foreground sm:block" />
            <Input
              className="font-mono"
              placeholder={t("setting.tags.batch-new-placeholder")}
              value={batchNewTag}
              onChange={(e) => setBatchNewTag(e.target.value)}
            />
            <Button variant="outline" disabled={!batchOldTag.trim() || isRenamingTag} onClick={handleBatchRenameTag}>
              {t("setting.tags.batch-apply")}
            </Button>
          </div>
        </SettingPanel>
      </SettingGroup>

      <SettingGroup title={t("setting.tags.preset-title")} description={t("setting.tags.preset-description")} showSeparator>
        <SettingPanel>
          <div className="grid gap-2 px-3 py-3 sm:grid-cols-2">
            {DEFAULT_PKM_TAGS.map((preset) => {
              const matchedColor = colorToHex(findTagMetadata(preset.name, previewTagsSetting)?.backgroundColor);
              return (
                <div key={preset.name} className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-2.5 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn("size-2.5 shrink-0 rounded-full border border-border", !matchedColor && "bg-transparent")}
                      style={matchedColor ? { backgroundColor: matchedColor } : undefined}
                      aria-hidden
                    />
                    <span className="font-mono text-sm font-medium text-foreground">#{preset.name}</span>
                  </div>
                  <span className="truncate text-xs text-muted-foreground">{t(preset.purposeKey)}</span>
                </div>
              );
            })}
          </div>
        </SettingPanel>
      </SettingGroup>
    </SettingSection>
  );
};

export default TagsSection;
