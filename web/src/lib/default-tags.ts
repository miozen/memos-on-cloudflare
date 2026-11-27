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

export const DEFAULT_PKM_PRESET_SECONDARY_TAGS_BY_ROOT: Record<string, readonly string[]> = {
  日常: ["随笔", "生活感悟", "个人见闻", "购物", "美食烹饪", "影音娱乐", "阅读", "社交", "兴趣爱好", "回忆", "汽车"],
  灵感: ["产品创意", "功能设计", "商业构想", "内容创作", "设计创意", "技术构想", "生活创意", "写作构思"],
  待办: ["个人事务", "采购计划", "工作事项", "家庭事务", "项目任务", "财务处理", "学习计划", "联系沟通"],
  资料: [
    "历史",
    "法律",
    "政策",
    "地理",
    "经济",
    "政治",
    "文学",
    "哲学",
    "教育",
    "语言",
    "文化",
    "自然科学",
    "社会科学",
    "百科常识",
    "书摘",
    "新闻资讯",
    "资源收藏",
  ],
  技术: [
    "Cloudflare",
    "AI工具",
    "前端开发",
    "后端开发",
    "桌面开发",
    "移动开发",
    "数据库",
    "网络技术",
    "网络安全",
    "Linux",
    "Windows",
    "OpenWrt",
    "Sing-box",
    "Docker",
    "Git",
    "TypeScript",
    "Python",
    "CSharp",
    "CAD",
    "运维部署",
    "架构设计",
    "效率软件",
    "硬件设备",
  ],
  项目: ["谱匠", "Omnia", "Memos", "万象收银", "云族谱", "PixShell", "导航页"],
  工作: [
    "通信设计",
    "门店经营",
    "项目管理",
    "客户管理",
    "团队管理",
    "会议纪要",
    "汇报总结",
    "行业动态",
    "市场营销",
    "供应链",
    "商品管理",
    "商业合作",
  ],
  财务: ["投资理财", "消费", "收支记账", "预算", "经营成本", "税务", "保险", "资产管理", "银行业务", "债务管理"],
  家族: ["族谱", "迁徙历史", "人物传记", "宗族文献", "口述历史", "老宅故土", "世系考据", "家风家训", "宗祠", "祭祀", "家族事务"],
  家庭: ["房屋设计", "房屋建设", "装修", "家居", "子女教育", "亲子关系", "家务", "亲友往来", "宠物", "家庭活动", "家用电器"],
  健康: ["饮食营养", "运动健身", "睡眠", "体检", "疾病", "就医记录", "药品", "中医中药", "心理健康", "体重管理", "养生", "个人护理"],
  旅行: ["旅行攻略", "自然风光", "人文景观", "历史古迹", "自驾游", "交通出行", "住宿", "地方美食", "旅行见闻"],
};

export const DEFAULT_PKM_PRESET_SECONDARY_TAGS: readonly string[] = DEFAULT_PKM_TAG_NAMES.flatMap((root) =>
  (DEFAULT_PKM_PRESET_SECONDARY_TAGS_BY_ROOT[root] ?? []).map((sub) => `${root}/${sub}`),
);
