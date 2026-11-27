import type { Translations } from "@/utils/i18n";

export interface DefaultTagPreset {
  name: string;
  purposeKey: Translations;
  defaultColor: string;
}

export const DEFAULT_PKM_TAGS: readonly DefaultTagPreset[] = [
  { name: "日常", purposeKey: "setting.tags.preset-purposes.daily", defaultColor: "#0080ff" },
  { name: "灵感", purposeKey: "setting.tags.preset-purposes.inspiration", defaultColor: "#0080ff" },
  { name: "待办", purposeKey: "setting.tags.preset-purposes.todo", defaultColor: "#ff8000" },
  { name: "资料", purposeKey: "setting.tags.preset-purposes.reference", defaultColor: "#0080ff" },
  { name: "技术", purposeKey: "setting.tags.preset-purposes.tech", defaultColor: "#00cc66" },
  { name: "项目", purposeKey: "setting.tags.preset-purposes.project", defaultColor: "#00cc66" },
  { name: "工作", purposeKey: "setting.tags.preset-purposes.work", defaultColor: "#00cc66" },
  { name: "财务", purposeKey: "setting.tags.preset-purposes.finance", defaultColor: "#00cc66" },
  { name: "家族", purposeKey: "setting.tags.preset-purposes.clan", defaultColor: "#8b5cf6" },
  { name: "家庭", purposeKey: "setting.tags.preset-purposes.family", defaultColor: "#8b5cf6" },
  { name: "健康", purposeKey: "setting.tags.preset-purposes.health", defaultColor: "#8b5cf6" },
  { name: "旅行", purposeKey: "setting.tags.preset-purposes.travel", defaultColor: "#8b5cf6" },
];

export const DEFAULT_PKM_TAG_NAMES: readonly string[] = DEFAULT_PKM_TAGS.map((tag) => tag.name);
