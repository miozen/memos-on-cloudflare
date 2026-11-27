import { create } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MemoDisplaySettingMenu from "@/components/MemoDisplaySettingMenu";
import TagsSection from "@/components/MemoExplorer/TagsSection";
import PreferencesSection from "@/components/Settings/PreferencesSection";
import AdminTagsSection from "@/components/Settings/TagsSection";
import { type MemoFilter } from "@/contexts/MemoFilterContext";
import { useMemoFilters } from "@/hooks/useMemoFilters";
import { InstanceSetting_TagsSettingSchema } from "@/types/proto/api/v1/instance_service_pb";

let activeFilters: MemoFilter[] = [];
const addFilterMock = vi.fn((filter: MemoFilter) => {
  if (!activeFilters.some((f) => f.factor === filter.factor && f.value === filter.value)) {
    activeFilters = [...activeFilters, filter];
  }
});
const removeFilterMock = vi.fn((predicate: (f: MemoFilter) => boolean) => {
  activeFilters = activeFilters.filter((f) => !predicate(f));
});
const removeFiltersByFactorMock = vi.fn((factor: MemoFilter["factor"]) => {
  activeFilters = activeFilters.filter((f) => f.factor !== factor);
});

const renameTagMock = vi.fn().mockResolvedValue({ updatedCount: 3, oldTag: "旧", newTag: "新" });
const exportMemosMock = vi.fn().mockResolvedValue(undefined);
const toastErrorMock = vi.fn();
const testQueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
  },
});

vi.mock("@/connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/connect")>();
  return {
    ...actual,
    memoServiceClient: {
      ...actual.memoServiceClient,
      renameTag: (...args: unknown[]) => renameTagMock(...args),
      exportMemos: (...args: unknown[]) => exportMemosMock(...args),
    },
  };
});

vi.mock("@/contexts/MemoFilterContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/contexts/MemoFilterContext")>();
  return {
    ...actual,
    useMemoFilterContext: () => ({
      filters: activeFilters,
      shortcut: undefined,
      getFiltersByFactor: (factor: MemoFilter["factor"]) => activeFilters.filter((f) => f.factor === factor),
      addFilter: addFilterMock,
      removeFilter: removeFilterMock,
      removeFiltersByFactor: removeFiltersByFactorMock,
    }),
  };
});

const stableInstanceValue = {
  tagsSetting: create(InstanceSetting_TagsSettingSchema, { tags: {} }),
  updateSetting: vi.fn(),
  fetchSetting: vi.fn(),
};

const stableAuthValue = {
  currentUser: { name: "users/alice" },
  userGeneralSetting: { locale: "zh-Hans", memoVisibility: "PRIVATE", theme: "system" },
  shortcuts: [],
  refetchSettings: vi.fn(),
};

const stableViewValue = {
  orderByTimeAsc: false,
  timeBasis: "create_time" as const,
  setTimeBasis: vi.fn(),
  toggleSortOrder: vi.fn(),
};

const stableTagCountsData = { 技术: 4, 项目: 2, 旧: 3 };

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => stableAuthValue,
}));

vi.mock("@/contexts/InstanceContext", () => ({
  useInstance: () => stableInstanceValue,
}));

vi.mock("@/contexts/ViewContext", () => ({
  useView: () => stableViewValue,
}));

vi.mock("@/hooks/useUserQueries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useUserQueries")>();
  return {
    ...actual,
    useTagCounts: () => ({ data: stableTagCountsData }),
    useUpdateUserGeneralSetting: () => ({ mutate: vi.fn() }),
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
  toast: {
    success: vi.fn(),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

describe("PKM workflow enhancements", () => {
  beforeEach(() => {
    activeFilters = [];
    window.localStorage.clear();
    addFilterMock.mockClear();
    removeFilterMock.mockClear();
    removeFiltersByFactorMock.mockClear();
    renameTagMock.mockReset().mockResolvedValue({ updatedCount: 3, oldTag: "旧", newTag: "新" });
    exportMemosMock.mockReset().mockResolvedValue(undefined);
    toastErrorMock.mockReset();
  });

  it("supports multi-tag AND filtering via modifier click and builds combined CEL filter", () => {
    render(<TagsSection tagCount={{ 技术: 4, 项目: 2 }} />);

    fireEvent.click(screen.getByText("技术"));
    expect(activeFilters).toEqual([{ factor: "tagSearch", value: "技术" }]);

    // Ctrl+click appends second tag instead of replacing the first.
    fireEvent.click(screen.getByText("项目"), { ctrlKey: true });
    expect(activeFilters).toEqual([
      { factor: "tagSearch", value: "技术" },
      { factor: "tagSearch", value: "项目" },
    ]);

    const { result } = renderHook(() => useMemoFilters({ creatorName: "users/alice" }));
    expect(result.current).toContain('tag in ["技术"] && tag in ["项目"]');
  });

  it("toggles incomplete tasks filter from MemoDisplaySettingMenu and compiles has_incomplete_tasks", () => {
    render(<MemoDisplaySettingMenu />);

    fireEvent.click(screen.getByRole("button"));
    const incompleteSwitch = screen.getByRole("switch");
    fireEvent.click(incompleteSwitch);

    expect(activeFilters).toEqual([{ factor: "property.hasIncompleteTask", value: "true" }]);

    const { result } = renderHook(() => useMemoFilters({ creatorName: "users/alice" }));
    expect(result.current).toContain("has_incomplete_tasks");
  });

  it("triggers batch tag rename and memo export from Settings UI", async () => {
    const invalidateQueriesSpy = vi.spyOn(testQueryClient, "invalidateQueries").mockResolvedValue(undefined);
    render(
      <QueryClientProvider client={testQueryClient}>
        <AdminTagsSection />
        <PreferencesSection />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByPlaceholderText("tag.old-name"), { target: { value: "#旧" } });
    fireEvent.change(screen.getByPlaceholderText("setting.tags.batch-new-placeholder"), { target: { value: "新" } });
    fireEvent.click(screen.getByRole("button", { name: "setting.tags.batch-apply" }));

    await waitFor(() => {
      expect(renameTagMock).toHaveBeenCalledWith({ oldTag: "旧", newTag: "新" });
      expect(toastErrorMock).not.toHaveBeenCalled();
      expect(invalidateQueriesSpy).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole("button", { name: "setting.preference.export-markdown" }));
    await waitFor(() => {
      expect(exportMemosMock).toHaveBeenCalledWith("markdown");
      expect(screen.getByRole("button", { name: "setting.preference.export-json" })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "setting.preference.export-json" }));
    await waitFor(() => {
      expect(exportMemosMock).toHaveBeenCalledWith("json");
    });
  });
});
