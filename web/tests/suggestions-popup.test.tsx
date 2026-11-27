import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SuggestionsPopup } from "@/components/MemoEditor/Editor/SuggestionsPopup";
import { useSuggestions } from "@/components/MemoEditor/Editor/useSuggestions";

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

  it("prevents textarea blur on option mouseDown and ignores Enter while IME is composing", () => {
    const onSelect = vi.fn();
    render(
      <SuggestionsPopup
        position={{ left: 0, top: 10, height: 20 }}
        suggestions={["日常"]}
        selectedIndex={0}
        onItemSelect={onSelect}
        getItemKey={(tag) => tag}
        renderItem={(tag) => `#${tag}`}
      />,
    );

    const item = screen.getByText("#日常");
    const mouseDownEvt = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    item.dispatchEvent(mouseDownEvt);
    expect(mouseDownEvt.defaultPrevented).toBe(true);
    expect(onSelect).toHaveBeenCalledWith("日常");

    const onAutocomplete = vi.fn();
    function TestEditor() {
      const editorRef = useRef<HTMLTextAreaElement>(null);
      const actionsRef = useRef({
        getEditor: () => editorRef.current,
        focus: vi.fn(),
        scrollToCursor: vi.fn(),
        insertText: vi.fn(),
        removeText: vi.fn(),
        setContent: vi.fn(),
        getSelectedContent: () => "",
        getContent: () => "",
        getCursorPosition: () => 0,
        setCursorPosition: vi.fn(),
        getCursorLineNumber: () => 0,
        getLine: () => "",
        setLine: vi.fn(),
      });
      const { isVisible } = useSuggestions({
        editorRef,
        editorActions: actionsRef,
        triggerChar: "#",
        items: ["日常", "技术"],
        filterItems: (items, q) => items.filter((item) => item.includes(q)),
        onAutocomplete,
      });
      return (
        <div>
          <textarea ref={editorRef} data-testid="ime-editor" />
          <span data-testid="visible">{String(isVisible)}</span>
        </div>
      );
    }

    render(<TestEditor />);
    const textarea = screen.getByTestId("ime-editor") as HTMLTextAreaElement;
    textarea.value = "#日";
    textarea.selectionStart = 2;
    textarea.selectionEnd = 2;
    fireEvent.input(textarea);
    expect(screen.getByTestId("visible").textContent).toBe("true");

    fireEvent.compositionStart(textarea);
    const imeEnter = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, bubbles: true, cancelable: true });
    Object.defineProperty(imeEnter, "isComposing", { value: true });
    textarea.dispatchEvent(imeEnter);
    expect(onAutocomplete).not.toHaveBeenCalled();

    // Safari race: Enter immediately (<100ms) after compositionend is also ignored.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10000);
      fireEvent.compositionEnd(textarea);
      vi.advanceTimersByTime(10);
      const postCompositionEnter = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
      textarea.dispatchEvent(postCompositionEnter);
      expect(onAutocomplete).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
