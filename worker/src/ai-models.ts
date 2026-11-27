export interface WorkersAITextModelOption {
  id: string;
  label: string;
  description: string;
}

export const DEFAULT_TAG_SUGGESTION_MODEL = "@cf/meta/llama-3.1-8b-instruct";

/**
 * Curated Workers AI text generation models verified against Cloudflare Workers AI
 * official model documentation, keeping the existing Llama 3.1 8B model as default.
 */
export const WORKERS_AI_TAG_MODELS: readonly WorkersAITextModelOption[] = [
  {
    id: "@cf/meta/llama-3.1-8b-instruct",
    label: "Llama 3.1 8B Instruct (默认)",
    description: "当前默认轻量模型，响应快、开销低。",
  },
  {
    id: "@cf/zai-org/glm-4.7-flash",
    label: "GLM-4.7 Flash",
    description: "多语言快速模型，中文理解与指令遵循能力较强。",
  },
  {
    id: "@cf/qwen/qwen3.8-27b",
    label: "Qwen 3.8 27B",
    description: "通义千问 27B 指令模型，中文语义理解与复杂归类表现稳健。",
  },
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    label: "Llama 3.3 70B Instruct FP8 Fast",
    description: "高精度 70B 量化加速模型，指令遵循与结构化输出稳定。",
  },
  {
    id: "@cf/meta/llama-4-scout-17b-16e-instruct",
    label: "Llama 4 Scout 17B",
    description: "Meta MoE 架构模型，支持多语言长上下文理解。",
  },
] as const;

const SUPPORTED_MODEL_SET = new Set<string>(WORKERS_AI_TAG_MODELS.map((item) => item.id));

export function isSupportedTagSuggestionModel(model: unknown): model is string {
  return typeof model === "string" && SUPPORTED_MODEL_SET.has(model.trim());
}

export function resolveTagSuggestionModel(rawAiSettingValue?: string | null): {
  model: string;
  fallbackReason?: string;
} {
  if (!rawAiSettingValue) {
    return { model: DEFAULT_TAG_SUGGESTION_MODEL };
  }

  try {
    const parsed = JSON.parse(rawAiSettingValue) as {
      tagSuggestion?: { model?: unknown };
    };
    const configured = parsed?.tagSuggestion?.model;
    if (configured === undefined || configured === null || configured === "") {
      return { model: DEFAULT_TAG_SUGGESTION_MODEL };
    }
    if (isSupportedTagSuggestionModel(configured)) {
      return { model: configured.trim() };
    }
    return {
      model: DEFAULT_TAG_SUGGESTION_MODEL,
      fallbackReason: `Unsupported tag suggestion model "${String(configured)}", falling back to default`,
    };
  } catch {
    return {
      model: DEFAULT_TAG_SUGGESTION_MODEL,
      fallbackReason: "Malformed AI setting JSON, falling back to default model",
    };
  }
}
