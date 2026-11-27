import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SuggestionsPopup } from "@/components/MemoEditor/Editor/SuggestionsPopup";

describe("SuggestionsPopup width and positioning", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("sizes to content with compact min-width, elastic width, and scrollbar-gutter", () => {
    render(
      <SuggestionsPopup
        position={{ left: 0, top: 10, height: 20 }}
        suggestions={["日常", "灵感", "待办"]}
        selectedIndex={0}
        onItemSelect={vi.fn()}
        getItemKey={(tag) => tag}
        renderItem={(tag) => `#${tag}`}
      />,
    );

    const firstItem = screen.getByText("#日常");
    const popup = firstItem.parentElement as HTMLDivElement;
    expect(popup.className).toContain("w-max");
    expect(popup.className).toContain("min-w-24");
    expect(popup.className).toContain("[scrollbar-gutter:stable]");
    expect(popup.style.left).toBe("0px");
  });

  it("clamps left position near the right edge of the editor container", () => {
    const parentEl = document.createElement("div");
    Object.defineProperty(parentEl, "clientWidth", { configurable: true, value: 600 });

    const originalOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
    const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");

    Object.defineProperty(HTMLElement.prototype, "offsetParent", {
      configurable: true,
      get() {
        return parentEl;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() {
        return 176;
      },
    });

    try {
      render(
        <SuggestionsPopup
          position={{ left: 560, top: 12, height: 20 }}
          suggestions={["日常", "技术"]}
          selectedIndex={0}
          onItemSelect={vi.fn()}
          getItemKey={(tag) => tag}
          renderItem={(tag) => `#${tag}`}
        />,
      );

      const popup = screen.getByText("#日常").parentElement as HTMLDivElement;
      // 600 (parent) - 176 (popup) = 424px maxLeft when computed marginLeft is 0 in jsdom
      expect(popup.style.left).toBe("424px");
    } finally {
      if (originalOffsetParent) {
        Object.defineProperty(HTMLElement.prototype, "offsetParent", originalOffsetParent);
      } else {
        delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent;
      }
      if (originalOffsetWidth) {
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
      } else {
        delete (HTMLElement.prototype as { offsetWidth?: unknown }).offsetWidth;
      }
    }
  });
});
