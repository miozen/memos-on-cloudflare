import { create } from "@bufbuild/protobuf";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TagSuggestions from "@/components/MemoEditor/Editor/TagSuggestions";
import TagsSection from "@/components/Settings/TagsSection";
import { colorToHex } from "@/lib/color";
import { DEFAULT_PKM_TAG_NAMES, DEFAULT_PKM_TAGS } from "@/lib/default-tags";
import { findTagMetadata } from "@/lib/tag";
import {
  InstanceSetting_Key,
  InstanceSetting_TagMetadataSchema,
  InstanceSetting_TagsSettingSchema,
} from "@/types/proto/api/v1/instance_service_pb";
import { remarkTag } from "@/utils/remark-plugins/remark-tag";

const updateSettingMock = vi.fn();
const fetchSettingMock = vi.fn();
let currentTagCounts: Record<string, number> = {};
const currentTagsSetting = create(InstanceSetting_TagsSettingSchema, {
  tags: {
    "^(日常|灵感|资料)$": create(InstanceSetting_TagMetadataSchema, {
      backgroundColor: { red: 0, green: 128 / 255, blue: 1 },
      blurContent: false,
    }),
    "^(待办)$": create(InstanceSetting_TagMetadataSchema, {
      backgroundColor: { red: 1, green: 128 / 255, blue: 0 },
      blurContent: false,
    }),
    "^(技术|项目|工作|财务)$": create(InstanceSetting_TagMetadataSchema, {
      backgroundColor: { red: 0, green: 204 / 255, blue: 102 / 255 },
      blurContent: false,
    }),
    "^(家族|家庭|健康|旅行)$": create(InstanceSetting_TagMetadataSchema, {
      backgroundColor: { red: 139 / 255, green: 92 / 255, blue: 246 / 255 },
      blurContent: false,
    }),
  },
});

vi.mock("@/contexts/InstanceContext", () => ({
  useInstance: () => ({
    tagsSetting: currentTagsSetting,
    updateSetting: updateSettingMock,
    fetchSetting: fetchSettingMock,
  }),
}));

vi.mock("@/hooks/useUserQueries", () => ({
  useTagCounts: () => ({
    data: currentTagCounts,
  }),
}));

vi.mock("@/utils/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/i18n")>();
  return {
    ...actual,
    useTranslate: () => (key: string) => key,
  };
});

vi.mock("react-hot-toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const capturedSuggestionsItems: string[][] = [];
vi.mock("@/components/MemoEditor/Editor/useSuggestions", () => ({
  useSuggestions: (options: { items: string[] }) => {
    capturedSuggestionsItems.push(options.items);
    return {
      position: { left: 0, top: 0, height: 16 },
      suggestions: options.items,
      selectedIndex: 0,
      isVisible: true,
      searchQuery: "",
      handleItemSelect: vi.fn(),
    };
  },
}));

describe("default PKM tag rules and UI", () => {
  beforeEach(() => {
    currentTagCounts = {};
    capturedSuggestionsItems.length = 0;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    updateSettingMock.mockReset().mockResolvedValue(undefined);
    fetchSettingMock.mockReset().mockResolvedValue(undefined);
  });

  it("matches all 12 preset Chinese tags to their expected colors with blur disabled", () => {
    const expectedHexByTag: Record<string, string> = {
      日常: "#0080ff",
      灵感: "#0080ff",
      资料: "#0080ff",
      待办: "#ff8000",
      技术: "#00cc66",
      项目: "#00cc66",
      工作: "#00cc66",
      财务: "#00cc66",
      家族: "#8b5cf6",
      家庭: "#8b5cf6",
      健康: "#8b5cf6",
      旅行: "#8b5cf6",
    };

    expect(Object.keys(expectedHexByTag)).toHaveLength(12);
    for (const [tag, expectedHex] of Object.entries(expectedHexByTag)) {
      const meta = findTagMetadata(tag, currentTagsSetting);
      expect(meta, `expected metadata for #${tag}`).toBeDefined();
      expect(colorToHex(meta?.backgroundColor)).toBe(expectedHex);
      expect(meta?.blurContent).toBe(false);
    }
  });

  it("does not match unknown or partial tags against the anchored default rules", () => {
    for (const unknownTag of ["未知标签", "日常生活", "技术/前端", "工作日报", "待办事项", "daily", "work"]) {
      expect(findTagMetadata(unknownTag, currentTagsSetting)).toBeUndefined();
    }
  });

  it("does not parse plain-text keywords without # or trigger blur when blurContent is false", () => {
    const plainParagraph = "今天日常处理了很多技术与项目工作，顺便规划家庭旅行、健康检查和财务待办，记录一条灵感资料和家族历史。";
    const parsedTags: string[] = [];

    render(
      <ReactMarkdown
        remarkPlugins={[remarkTag]}
        components={{
          span: ({ children, ...props }) => {
            const tag = (props as Record<string, unknown>)["data-tag"];
            if (typeof tag === "string") {
              parsedTags.push(tag);
            }
            return <span {...props}>{children}</span>;
          },
        }}
      >
        {plainParagraph}
      </ReactMarkdown>,
    );

    expect(parsedTags).toEqual([]);
    const shouldBlurPlain = parsedTags.some((tag) => findTagMetadata(tag, currentTagsSetting)?.blurContent);
    expect(shouldBlurPlain).toBe(false);

    const shouldBlurDefaultTags = DEFAULT_PKM_TAG_NAMES.some((tag) => findTagMetadata(tag, currentTagsSetting)?.blurContent);
    expect(shouldBlurDefaultTags).toBe(false);
  });

  it("extracts #tags including all 12 preset Chinese tags in markdown", () => {
    const parsedTags: string[] = [];
    const content = DEFAULT_PKM_TAG_NAMES.map((tag) => `#${tag}`).join(" ");

    render(
      <ReactMarkdown
        remarkPlugins={[remarkTag]}
        components={{
          span: ({ children, ...props }) => {
            const tag = (props as Record<string, unknown>)["data-tag"];
            if (typeof tag === "string") {
              parsedTags.push(tag);
            }
            return <span {...props}>{children}</span>;
          },
        }}
      >
        {content}
      </ReactMarkdown>,
    );

    expect(parsedTags).toEqual([...DEFAULT_PKM_TAG_NAMES]);
  });

  it("displays the 4 default rules and lightweight 12-tag preset reference in TagsSection without breaking edits", async () => {
    render(<TagsSection />);

    expect(screen.getByText("^(日常|灵感|资料)$")).toBeInTheDocument();
    expect(screen.getByText("^(待办)$")).toBeInTheDocument();
    expect(screen.getByText("^(技术|项目|工作|财务)$")).toBeInTheDocument();
    expect(screen.getByText("^(家族|家庭|健康|旅行)$")).toBeInTheDocument();

    for (const preset of DEFAULT_PKM_TAGS) {
      expect(screen.getByText(`#${preset.name}`)).toBeInTheDocument();
      expect(screen.getByText(preset.purposeKey)).toBeInTheDocument();
    }

    const input = screen.getByPlaceholderText("setting.tags.tag-name-placeholder");
    fireEvent.change(input, { target: { value: "custom/.*" } });
    fireEvent.click(screen.getByRole("button", { name: "common.add" }));

    const saveButton = screen.getByRole("button", { name: "common.save" });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(updateSettingMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: `instance/settings/${InstanceSetting_Key[InstanceSetting_Key.TAGS]}`,
        }),
      );
    });
  });

  it("provides the 12 preset tags as # autocomplete suggestions after used tags without duplicates", () => {
    currentTagCounts = {
      自定义标签: 5,
      技术: 3,
    };

    render(<TagSuggestions editorRef={{ current: null }} editorActions={null} />);

    expect(capturedSuggestionsItems).toHaveLength(1);
    const items = capturedSuggestionsItems[0];
    expect(items.slice(0, 2)).toEqual(["自定义标签", "技术"]);
    expect(items).toHaveLength(13);
    expect(new Set(items).size).toBe(13);
    for (const tag of DEFAULT_PKM_TAG_NAMES) {
      expect(items).toContain(tag);
    }
  });
});
