import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AISection from "@/components/Settings/AISection";
import { InstanceSetting_Key } from "@/types/proto/api/v1/instance_service_pb";

const updateSettingMock = vi.fn();
const fetchSettingMock = vi.fn();
let currentAiSetting: { providers: unknown[]; transcription?: { model?: string; language?: string } } = {
  providers: [],
};

vi.mock("@/contexts/InstanceContext", () => ({
  useInstance: () => ({
    aiSetting: currentAiSetting,
    updateSetting: updateSettingMock,
    fetchSetting: fetchSettingMock,
  }),
}));

vi.mock("@/utils/i18n", () => ({
  useTranslate: () => (key: string) => key,
}));

vi.mock("react-hot-toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("AISection", () => {
  beforeEach(() => {
    currentAiSetting = { providers: [] };
    updateSettingMock.mockReset().mockResolvedValue(undefined);
    fetchSettingMock.mockReset().mockResolvedValue(undefined);
  });

  it("saves AI settings through InstanceContext updater so context state stays in sync", async () => {
    render(<AISection />);

    const toggle = screen.getByRole("switch");
    fireEvent.click(toggle);

    const saveButton = screen.getByRole("button", { name: "common.save" });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(updateSettingMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: `instance/settings/${InstanceSetting_Key[InstanceSetting_Key.AI]}`,
          value: expect.objectContaining({
            case: "aiSetting",
          }),
        }),
      );
      expect(fetchSettingMock).toHaveBeenCalledWith(InstanceSetting_Key.AI);
    });
  });

  it("syncs local state when aiSetting prop updates", () => {
    const { rerender } = render(<AISection />);
    expect(screen.getByRole("switch")).not.toBeChecked();

    currentAiSetting = {
      providers: [{ id: "cloudflare-ai" }],
      transcription: { model: "@cf/openai/whisper", language: "zh" },
    };
    rerender(<AISection />);

    expect(screen.getByRole("switch")).toBeChecked();
    expect(screen.getByDisplayValue("zh")).toBeInTheDocument();
  });
});
