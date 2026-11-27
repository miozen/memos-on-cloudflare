import { create } from "@bufbuild/protobuf";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MentionResolutionProvider } from "@/components/MemoContent/MentionResolutionContext";
import { MemoPreview } from "@/components/MemoPreview";
import MemoBody from "@/components/MemoView/components/MemoBody";
import { MemoViewContext, type MemoViewContextValue } from "@/components/MemoView/MemoViewContext";
import { type Attachment, AttachmentSchema, MotionMediaFamily, MotionMediaRole } from "@/types/proto/api/v1/attachment_service_pb";
import { InstanceSetting_TagMetadataSchema, InstanceSetting_TagsSettingSchema } from "@/types/proto/api/v1/instance_service_pb";
import { type Memo, MemoSchema } from "@/types/proto/api/v1/memo_service_pb";

const addFilterMock = vi.fn();
const removeFilterMock = vi.fn();
const navigateToMock = vi.fn();
const openEditorMock = vi.fn();
const openPreviewMock = vi.fn();
const toggleBlurMock = vi.fn();

let currentTagsSetting = create(InstanceSetting_TagsSettingSchema, {
  tags: {
    "^(日常|灵感|资料)$": create(InstanceSetting_TagMetadataSchema, {
      backgroundColor: { red: 0, green: 128 / 255, blue: 1 },
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

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useLocation: () => ({ pathname: "/", search: "", hash: "", state: null, key: "default" }),
  };
});

vi.mock("@/hooks/useNavigateTo", () => ({
  default: () => navigateToMock,
}));

vi.mock("@/hooks/useUserQueries", () => ({
  useUsersByUsernames: () => ({ data: new Map() }),
}));

vi.mock("@/contexts/InstanceContext", () => ({
  useInstance: () => ({
    tagsSetting: currentTagsSetting,
    memoRelatedSetting: { enableDoubleClickEdit: true },
  }),
}));

vi.mock("@/contexts/MemoFilterContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/contexts/MemoFilterContext")>();
  return {
    ...actual,
    useMemoFilterContext: () => ({
      getFiltersByFactor: () => [],
      addFilter: addFilterMock,
      removeFilter: removeFilterMock,
    }),
  };
});

vi.mock("@/utils/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/i18n")>();
  return {
    ...actual,
    useTranslate: () => (key: string) => key,
  };
});

vi.mock("@/components/MemoReactionListView", () => ({
  MemoReactionListView: () => null,
}));

vi.mock("@/components/MemoMetadata/Relation/RelationListView", () => ({
  default: () => null,
}));

vi.mock("@/components/MemoMetadata/Location/LocationDisplayView", () => ({
  default: () => null,
}));

function makeAttachment(overrides: Partial<Attachment>): Attachment {
  return create(AttachmentSchema, {
    name: "attachments/att-1",
    filename: "file.bin",
    type: "application/octet-stream",
    size: BigInt(1024),
    ...overrides,
  });
}

function renderMemoBody(memoOverrides: Partial<Memo>, contextOverrides: Partial<MemoViewContextValue> = {}, compact = false) {
  const memo = create(MemoSchema, {
    name: "memos/memo-1",
    content: "",
    tags: [],
    attachments: [],
    relations: [],
    reactions: [],
    ...memoOverrides,
  });

  const value: MemoViewContextValue = {
    memo,
    creator: undefined,
    currentUser: undefined,
    parentPage: "/",
    cardWidth: 600,
    isArchived: false,
    readonly: false,
    showBlurredContent: false,
    blurred: false,
    openEditor: openEditorMock,
    toggleBlurVisibility: toggleBlurMock,
    openPreview: openPreviewMock,
    ...contextOverrides,
  };

  return render(
    <MentionResolutionProvider contents={[]}>
      <MemoViewContext.Provider value={value}>
        <MemoBody compact={compact} />
      </MemoViewContext.Provider>
    </MentionResolutionProvider>,
  );
}

function isBeforeInDom(first: Node, second: Node): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe("MemoBody tag positioning", () => {
  beforeEach(() => {
    addFilterMock.mockReset();
    removeFilterMock.mockReset();
    navigateToMock.mockReset();
    openEditorMock.mockReset();
    openPreviewMock.mockReset();
    toggleBlurMock.mockReset();
    currentTagsSetting = create(InstanceSetting_TagsSettingSchema, {
      tags: {
        "^(日常|灵感|资料)$": create(InstanceSetting_TagMetadataSchema, {
          backgroundColor: { red: 0, green: 128 / 255, blue: 1 },
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
  });

  it("keeps tags inside MemoContent for text-only memos", () => {
    const { container } = renderMemoBody({
      content: "笔记正文内容\n\n#技术 #项目",
      tags: ["技术", "项目"],
      attachments: [],
    });

    const contentEl = container.querySelector("[data-memo-content]")!;
    expect(contentEl).toBeInTheDocument();
    expect(screen.queryByTestId("memo-tags")).not.toBeInTheDocument();

    const tags = container.querySelectorAll("[data-tag]");
    expect(Array.from(tags).map((el) => el.getAttribute("data-tag"))).toEqual(["技术", "项目"]);
    expect(contentEl.contains(tags[0])).toBe(true);
  });

  it("places tags below a single image attachment without duplicating them in content", () => {
    const { container } = renderMemoBody({
      content: "周末记录\n\n#旅行 #日常",
      tags: ["旅行", "日常"],
      attachments: [
        makeAttachment({
          name: "attachments/img-1",
          filename: "photo.jpg",
          type: "image/jpeg",
        }),
      ],
    });

    const contentEl = container.querySelector("[data-memo-content]")!;
    const imgEl = screen.getByRole("img", { name: "photo.jpg" });
    const memoTagsEl = screen.getByTestId("memo-tags");

    expect(contentEl.textContent).toContain("周末记录");
    expect(contentEl.querySelectorAll("[data-tag]")).toHaveLength(0);
    expect(contentEl.textContent).not.toContain("#旅行");
    expect(contentEl.textContent).not.toContain("#日常");

    const renderedTags = memoTagsEl.querySelectorAll("[data-tag]");
    expect(Array.from(renderedTags).map((el) => el.getAttribute("data-tag"))).toEqual(["旅行", "日常"]);
    expect(isBeforeInDom(contentEl, imgEl)).toBe(true);
    expect(isBeforeInDom(imgEl, memoTagsEl)).toBe(true);

    // Clicking the image still triggers image preview.
    fireEvent.click(imgEl.closest("button")!);
    expect(openPreviewMock).toHaveBeenCalledTimes(1);
  });

  it("places tags below the entire gallery for multi-image and motion/video memos", () => {
    const { container } = renderMemoBody({
      content: "川西自驾全程记录 #旅行 #日常",
      tags: ["旅行", "日常"],
      attachments: [
        makeAttachment({ name: "attachments/1", filename: "p1.jpg", type: "image/jpeg" }),
        makeAttachment({ name: "attachments/2", filename: "p2.png", type: "image/png" }),
        makeAttachment({
          name: "attachments/3",
          filename: "live.jpg",
          type: "image/jpeg",
          motionMedia: { family: MotionMediaFamily.ANDROID_MOTION_PHOTO, role: MotionMediaRole.CONTAINER, hasEmbeddedVideo: true },
        }),
      ],
    });

    const contentEl = container.querySelector("[data-memo-content]")!;
    const images = screen.getAllByRole("img");
    const memoTagsEl = screen.getByTestId("memo-tags");

    expect(images).toHaveLength(3);
    expect(contentEl.querySelectorAll("[data-tag]")).toHaveLength(0);
    for (const img of images) {
      expect(isBeforeInDom(img, memoTagsEl)).toBe(true);
    }
    expect(Array.from(memoTagsEl.querySelectorAll("[data-tag]")).map((el) => el.getAttribute("data-tag"))).toEqual(["旅行", "日常"]);
  });

  it("keeps tags in MemoContent when attachments are only documents or audio", () => {
    const { container } = renderMemoBody({
      content: "接口设计文档说明\n#技术 #资料",
      tags: ["技术", "资料"],
      attachments: [
        makeAttachment({ name: "attachments/pdf-1", filename: "spec.pdf", type: "application/pdf" }),
        makeAttachment({ name: "attachments/aud-1", filename: "voice.mp3", type: "audio/mpeg" }),
      ],
    });

    const contentEl = container.querySelector("[data-memo-content]")!;
    const attachmentTitle = screen.getByText("spec.pdf");
    expect(screen.queryByTestId("memo-tags")).not.toBeInTheDocument();

    const tags = container.querySelectorAll("[data-tag]");
    expect(Array.from(tags).map((el) => el.getAttribute("data-tag"))).toEqual(["技术", "资料"]);
    expect(contentEl.contains(tags[0])).toBe(true);
    expect(isBeforeInDom(tags[0], attachmentTitle)).toBe(true);
  });

  it("renders no empty tag container when visual memos have no tags or tag-only content", () => {
    const { container, rerender } = renderMemoBody({
      content: "纯图片无标签描述",
      tags: [],
      attachments: [makeAttachment({ name: "attachments/1", filename: "pic.webp", type: "image/webp" })],
    });

    expect(screen.queryByTestId("memo-tags")).not.toBeInTheDocument();
    expect(container.querySelectorAll("[data-tag]")).toHaveLength(0);

    // When content only consists of tags alongside an image, MemoContent omits empty spacer DOM.
    const tagsOnlyMemo = create(MemoSchema, {
      name: "memos/memo-tags-only",
      content: "#旅行 #日常",
      tags: ["旅行", "日常"],
      attachments: [makeAttachment({ name: "attachments/1", filename: "pic.webp", type: "image/webp" })],
      relations: [],
      reactions: [],
    });
    rerender(
      <MentionResolutionProvider contents={[]}>
        <MemoViewContext.Provider
          value={{
            memo: tagsOnlyMemo,
            creator: undefined,
            currentUser: undefined,
            parentPage: "/",
            cardWidth: 600,
            isArchived: false,
            readonly: false,
            showBlurredContent: false,
            blurred: false,
            openEditor: openEditorMock,
            toggleBlurVisibility: toggleBlurMock,
            openPreview: openPreviewMock,
          }}
        >
          <MemoBody compact={false} />
        </MemoViewContext.Provider>
      </MentionResolutionProvider>,
    );

    expect(container.querySelector("[data-memo-content]")).not.toBeInTheDocument();
    expect(screen.getByTestId("memo-tags").querySelectorAll("[data-tag]")).toHaveLength(2);
  });

  it("deduplicates tags, preserves colors, handles tag click filtering, and respects blur and double-click edit", () => {
    const { container } = renderMemoBody(
      {
        content: "第一次写 #技术\n中间记录问题\n第二次写 #技术 #项目",
        tags: ["技术", "技术", "项目"],
        attachments: [makeAttachment({ name: "attachments/1", filename: "arch.png", type: "image/png" })],
      },
      { blurred: true, showBlurredContent: false },
    );

    const memoTagsEl = screen.getByTestId("memo-tags");
    const renderedTags = Array.from(memoTagsEl.querySelectorAll("[data-tag]"));
    expect(renderedTags.map((el) => el.getAttribute("data-tag"))).toEqual(["技术", "项目"]);
    expect(renderedTags[0]).toHaveStyle({ borderColor: "#00cc66" });

    // Blur styling still wraps both content, attachments, and moved tags.
    expect(container.querySelector(".blur-lg")).toBeInTheDocument();

    // Clicking a moved tag filters without bubbling to MemoContent handlers.
    fireEvent.click(renderedTags[0]);
    expect(addFilterMock).toHaveBeenCalledWith({ factor: "tagSearch", value: "技术" });

    // Double clicking MemoContent still opens editor.
    fireEvent.doubleClick(container.querySelector("[data-memo-content]")!);
    expect(openEditorMock).toHaveBeenCalledTimes(1);
  });

  it("keeps tags intact in other MemoContent consumers such as MemoPreview", () => {
    const { container } = render(
      <MentionResolutionProvider contents={[]}>
        <MemoPreview content="引用笔记 #工作" attachments={[]} />
      </MentionResolutionProvider>,
    );

    const tag = container.querySelector('[data-tag="工作"]');
    expect(tag).toBeInTheDocument();
  });

  it("places tags outside collapsible MemoContent below show-more and show-less without duplication", () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 600,
      height: 900,
      top: 0,
      left: 0,
      bottom: 900,
      right: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    try {
      const { container } = renderMemoBody(
        {
          content: "很长的笔记正文第一段\n\n很长的笔记正文最后一段\n#资料 #日常",
          tags: ["资料", "日常"],
          attachments: [],
        },
        {},
        true,
      );

      const contentEl = container.querySelector("[data-memo-content]")!;
      const showMoreBtn = screen.getByRole("button", { name: "memo.show-more" });
      const memoTagsEl = screen.getByTestId("memo-tags");

      expect(contentEl.querySelectorAll("[data-tag]")).toHaveLength(0);
      expect(isBeforeInDom(showMoreBtn, memoTagsEl)).toBe(true);
      expect(Array.from(memoTagsEl.querySelectorAll("[data-tag]")).map((el) => el.getAttribute("data-tag"))).toEqual(["资料", "日常"]);

      fireEvent.click(showMoreBtn);

      const showLessBtn = screen.getByRole("button", { name: "memo.show-less" });
      const expandedTagsEl = screen.getByTestId("memo-tags");
      expect(container.querySelector("[data-memo-content]")!.querySelectorAll("[data-tag]")).toHaveLength(0);
      expect(isBeforeInDom(showLessBtn, expandedTagsEl)).toBe(true);
      expect(expandedTagsEl.querySelectorAll("[data-tag]")).toHaveLength(2);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("keeps tags solely below visual attachments even when MemoContent is collapsible", () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 600,
      height: 900,
      top: 0,
      left: 0,
      bottom: 900,
      right: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    try {
      renderMemoBody(
        {
          content: "很长的图文笔记内容\n#资料",
          tags: ["资料"],
          attachments: [makeAttachment({ name: "attachments/1", filename: "photo.jpg", type: "image/jpeg" })],
        },
        {},
        true,
      );

      const imgEl = screen.getByRole("img", { name: "photo.jpg" });
      const allTagContainers = screen.getAllByTestId("memo-tags");
      expect(allTagContainers).toHaveLength(1);
      expect(isBeforeInDom(imgEl, allTagContainers[0])).toBe(true);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("never turns URL hash routes like #/pos or #/guest into tags or truncates link text when folded", () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 600,
      height: 900,
      top: 0,
      left: 0,
      bottom: 900,
      right: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    try {
      const { container } = renderMemoBody(
        {
          content: "浏览器固定打开：http://localhost:1520/#/pos\n副屏：http://localhost:1520/#/guest\n以及独立写法 #/pos #/guest #项目",
          tags: ["项目"],
          attachments: [],
        },
        {},
        true,
      );

      const contentEl = container.querySelector("[data-memo-content]")!;
      expect(contentEl.textContent).toContain("http://localhost:1520/#/pos");
      expect(contentEl.textContent).toContain("http://localhost:1520/#/guest");
      expect(contentEl.textContent).toContain("#/pos #/guest");
      expect(contentEl.querySelectorAll("[data-tag]")).toHaveLength(0);

      const memoTagsEl = screen.getByTestId("memo-tags");
      expect(Array.from(memoTagsEl.querySelectorAll("[data-tag]")).map((el) => el.getAttribute("data-tag"))).toEqual(["项目"]);
    } finally {
      rectSpy.mockRestore();
    }
  });
});
