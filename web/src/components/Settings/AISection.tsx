import { isEqual } from "lodash-es";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useInstance } from "@/contexts/InstanceContext";
import { InstanceSetting_Key } from "@/types/proto/api/v1/instance_service_pb";
import { useTranslate } from "@/utils/i18n";
import SettingGroup from "./SettingGroup";
import { SettingPanel } from "./SettingList";
import SettingRow from "./SettingRow";
import SettingSection from "./SettingSection";
import useInstanceSettingUpdater, { buildInstanceSettingName } from "./useInstanceSettingUpdater";

interface CloudflareAIConfig {
  enabled: boolean;
  transcriptionModel: string;
  transcriptionLanguage: string;
  tagSuggestionModel: string;
}

const DEFAULT_TRANSCRIPTION_MODEL = "@cf/openai/whisper";
const DEFAULT_TAG_SUGGESTION_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const LEGACY_TAG_MODEL_ALIASES: Record<string, string> = {
  "@cf/meta/llama-3.1-8b-instruct": DEFAULT_TAG_SUGGESTION_MODEL,
};

const WORKERS_AI_TAG_MODELS = [
  {
    id: "@cf/meta/llama-3.1-8b-instruct-fast",
    labelKey: "setting.ai.tag-model-llama-3-1-8b",
  },
  {
    id: "@cf/zai-org/glm-4.7-flash",
    labelKey: "setting.ai.tag-model-glm-4-7-flash",
  },
  {
    id: "@cf/qwen/qwen3.8-27b",
    labelKey: "setting.ai.tag-model-qwen-3-8-27b",
  },
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    labelKey: "setting.ai.tag-model-llama-3-3-70b",
  },
  {
    id: "@cf/meta/llama-4-scout-17b-16e-instruct",
    labelKey: "setting.ai.tag-model-llama-4-scout",
  },
] as const;

const SUPPORTED_TAG_MODEL_IDS = new Set<string>(WORKERS_AI_TAG_MODELS.map((m) => m.id));

function deriveConfig(aiSetting: unknown): { config: CloudflareAIConfig; invalidSavedTagModel?: string } {
  const setting = aiSetting as
    | {
        providers?: unknown[];
        transcription?: { model?: string; language?: string };
        tagSuggestion?: { model?: string };
      }
    | undefined;
  const hasProvider = (setting?.providers || []).length > 0;
  const transcription = setting?.transcription;
  const rawTagModel = setting?.tagSuggestion?.model;
  const normalizedTagModel = rawTagModel ? (LEGACY_TAG_MODEL_ALIASES[rawTagModel] ?? rawTagModel) : undefined;
  const isTagModelValid = !normalizedTagModel || SUPPORTED_TAG_MODEL_IDS.has(normalizedTagModel);

  return {
    config: {
      enabled: hasProvider,
      transcriptionModel: transcription?.model || DEFAULT_TRANSCRIPTION_MODEL,
      transcriptionLanguage: transcription?.language || "",
      tagSuggestionModel: isTagModelValid && normalizedTagModel ? normalizedTagModel : DEFAULT_TAG_SUGGESTION_MODEL,
    },
    invalidSavedTagModel: rawTagModel && !isTagModelValid ? rawTagModel : undefined,
  };
}

const AISection = () => {
  const t = useTranslate();
  const { aiSetting: originalSetting } = useInstance();
  const saveInstanceSetting = useInstanceSettingUpdater();
  const { config: savedConfig, invalidSavedTagModel } = useMemo(() => deriveConfig(originalSetting), [originalSetting]);
  const [config, setConfig] = useState<CloudflareAIConfig>(savedConfig);

  useEffect(() => {
    setConfig(savedConfig);
  }, [savedConfig]);

  const hasChanges = !isEqual(config, savedConfig) || Boolean(invalidSavedTagModel);

  const handleSave = async () => {
    const providers = config.enabled
      ? [
          {
            id: "cloudflare-ai",
            title: "Cloudflare Workers AI",
            type: 1,
            endpoint: "",
            apiKey: "",
            apiKeySet: true,
            apiKeyHint: "built-in",
          },
        ]
      : [];
    const transcription = config.enabled
      ? { providerId: "cloudflare-ai", model: config.transcriptionModel, language: config.transcriptionLanguage, prompt: "" }
      : undefined;
    const tagSuggestion = { model: config.tagSuggestionModel };

    await saveInstanceSetting({
      key: InstanceSetting_Key.AI,
      setting: {
        name: buildInstanceSettingName(InstanceSetting_Key.AI),
        value: { case: "aiSetting", value: { providers, transcription, tagSuggestion } },
      } as Parameters<typeof saveInstanceSetting>[0]["setting"],
      errorContext: "Failed to save AI settings",
    });
  };

  return (
    <SettingSection title={t("setting.ai.label")}>
      <SettingPanel className="bg-muted/30 px-4 py-3">
        <div className="flex max-w-3xl flex-col gap-2">
          <h4 className="text-sm font-semibold text-foreground">Cloudflare Workers AI</h4>
          <p className="text-sm text-muted-foreground">{t("setting.ai.cloudflare-ai-description")}</p>
        </div>
      </SettingPanel>

      <SettingGroup title={t("setting.ai.tag-suggestion-title")} description={t("setting.ai.tag-suggestion-description")}>
        <SettingRow label={t("setting.ai.tag-suggestion-model")} description={t("setting.ai.tag-suggestion-model-help")}>
          <Select
            value={config.tagSuggestionModel}
            onValueChange={(value) => setConfig((prev) => ({ ...prev, tagSuggestionModel: value }))}
          >
            <SelectTrigger className="w-72 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WORKERS_AI_TAG_MODELS.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {t(model.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {invalidSavedTagModel && (
          <p className="px-3 pb-2 text-xs text-destructive">
            {t("setting.ai.tag-suggestion-invalid-saved", { model: invalidSavedTagModel })}
          </p>
        )}
      </SettingGroup>

      <SettingGroup title={t("setting.ai.transcription-title")} description={t("setting.ai.transcription-description")} showSeparator>
        <SettingRow label={t("setting.ai.transcription-enable")} tooltip={t("setting.ai.transcription-enable-tooltip")}>
          <Switch checked={config.enabled} onCheckedChange={(checked) => setConfig((prev) => ({ ...prev, enabled: checked }))} />
        </SettingRow>

        {config.enabled && (
          <>
            <SettingRow label={t("setting.ai.transcription-model")} description={t("setting.ai.transcription-model-help")}>
              <Input
                className="w-64 font-mono"
                value={config.transcriptionModel}
                onChange={(e) => setConfig((prev) => ({ ...prev, transcriptionModel: e.target.value }))}
                placeholder={DEFAULT_TRANSCRIPTION_MODEL}
              />
            </SettingRow>

            <SettingRow label={t("setting.ai.transcription-language")} description={t("setting.ai.transcription-language-help")}>
              <Input
                className="w-32"
                value={config.transcriptionLanguage}
                onChange={(e) => setConfig((prev) => ({ ...prev, transcriptionLanguage: e.target.value }))}
                placeholder="en"
              />
            </SettingRow>
          </>
        )}
      </SettingGroup>

      <div className="w-full flex justify-end">
        <Button disabled={!hasChanges} onClick={handleSave}>
          {t("common.save")}
        </Button>
      </div>
    </SettingSection>
  );
};

export default AISection;
