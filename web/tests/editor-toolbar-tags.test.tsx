import { create } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorToolbar } from "@/components/MemoEditor/components/EditorToolbar";
import { EditorProvider, useEditorContext } from "@/components/MemoEditor/state";
import TagsSection from "@/components/MemoExplorer/TagsSection";
import {
  InstanceSetting_AISettingSchema,
  InstanceSetting_MemoRelatedSettingSchema,
  InstanceSetting_StorageSettingSchema,
} from "@/types/proto/api/v1/instance_service_pb";

const suggestTagsMock = vi.fn();

vi.mock("@/connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/connect")>();
  return {
    ...actual,
    aiServiceClient: {
      ...actual.aiServiceClient,
      suggestTags: (...args: unknown[]) => suggestTagsMock(...args),
    },
  };
});

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    currentUser: { name: "users/alice" },
    userGeneralSetting: { memoVisibility: "PRIVATE" },
    shortcuts: [],
    refetchSettings: vi.fn(),
  }),
}));

vi.mock("@/contexts/InstanceContext", () => ({
  useInstance: () => ({
    memoRelatedSetting: create(InstanceSetting_MemoRelatedSettingSchema, { contentLengthLimit: 0 }),
    storageSetting: create(InstanceSetting_StorageSettingSchema, { uploadSizeLimitMb: BigInt(100) }),
    aiSetting: create(InstanceSetting_AISettingSchema, { providers: [] }),
  }),
}));

vi.mock("@/contexts/MemoFilterContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/contexts/MemoFilterContext")>();
  return {
    ...actual,
    useMemoFilterContext: () => ({
      filters: [],
      getFiltersByFactor: () => [],
      addFilter: vi.fn(),
      removeFilter: vi.fn(),
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

vi.mock("react-hot-toast", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

const EditorHarness = ({
  initialContent,
  memoName,
}: {
  initialContent: string;
  memoName?: string;
}) => {
  const { actions, dispatch } = useEditorContext();
  return (
    <div>
      <button
        type="button"
        onClick={() => dispatch(actions.updateContent(initialContent))}
      >
        seed-content
      </button>
      <button type="button" onClick={() => dispatch(actions.reset())}>
        reset-editor
      </button>
      <EditorToolbar
        onSave={vi.fn()}
        memoName={memoName}
        onInsertSuggestedTag={vi.fn()}
      />
    </div>
  );
};

describe("EditorToolbar AI secondary tag suggestions", () => {
  beforeEach(() => {
    suggestTagsMock.mockReset();
    localStorage.clear();
  });

  it("renders new-tag hint only for new secondary tags and clears residual tags on editor reset", async () => {
    suggestTagsMock.mockResolvedValue({
      tags: ["技术/Cloudflare", "项目/谱匠", "日常"],
      suggestions: [
        { tag: "技术/Cloudflare", mode: "reuse" },
        { tag: "项目/谱匠", mode: "new" },
        { tag: "日常", mode: "primary" },
      ],
      source: "ai",
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <EditorProvider>
          <EditorHarness initialContent="Cloudflare 与谱匠记录" />
        </EditorProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByText("seed-content"));
    fireEvent.click(screen.getByRole("button", { name: "editor.suggest-tags" }));

    await waitFor(() => {
      expect(screen.getByText("+ #技术/Cloudflare")).toBeInTheDocument();
      expect(screen.getByText("+ #项目/谱匠")).toBeInTheDocument();
      expect(screen.getByText("+ #日常")).toBeInTheDocument();
    });

    // Only 1 "editor.suggested-tag-new" badge should appear (for mode === "new")
    expect(screen.getAllByText("editor.suggested-tag-new")).toHaveLength(1);

    // Resetting editor (e.g. after memo save) clears unpicked suggested tags
    fireEvent.click(screen.getByText("reset-editor"));
    expect(screen.queryByText("+ #技术/Cloudflare")).not.toBeInTheDocument();
    expect(screen.queryByText("+ #项目/谱匠")).not.toBeInTheDocument();
  });

  it("ignores stale in-flight suggestTags response after editor resets", async () => {
    let resolvePending: (val: unknown) => void = () => {};
    suggestTagsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePending = resolve;
        }),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <EditorProvider>
          <EditorHarness initialContent="待归类笔记" />
        </EditorProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByText("seed-content"));
    fireEvent.click(screen.getByRole("button", { name: "editor.suggest-tags" }));

    // Clear editor before the AI request resolves
    fireEvent.click(screen.getByText("reset-editor"));

    await act(async () => {
      resolvePending({
        tags: ["技术/Cloudflare"],
        suggestions: [{ tag: "技术/Cloudflare", mode: "new" }],
        source: "ai",
      });
    });

    expect(screen.queryByText("+ #技术/Cloudflare")).not.toBeInTheDocument();
  });
});

describe("MemoExplorer TagsSection default tree mode", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to tree mode when unset and respects stored flat preference", () => {
    const { unmount } = render(<TagsSection tagCount={{ "技术/Cloudflare": 2 }} />);
    // In tree mode, parent "技术" and child "Cloudflare" are rendered as separate tree nodes
    expect(screen.getByText("技术")).toBeInTheDocument();
    expect(screen.getByText(/Cloudflare/)).toBeInTheDocument();
    expect(screen.queryByText("技术/Cloudflare")).not.toBeInTheDocument();
    unmount();

    // Respects existing user preference for flat mode
    localStorage.setItem("tag-view-as-tree", "false");
    render(<TagsSection tagCount={{ "技术/Cloudflare": 2 }} />);
    expect(screen.getByText("技术/Cloudflare")).toBeInTheDocument();
  });
});
