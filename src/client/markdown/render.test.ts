// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderSummary } from "./render";

const html = (markdown: string) => {
  const box = document.createElement("div");
  box.innerHTML = renderSummary(markdown);
  return box;
};

describe("renderSummary", () => {
  it("renders Markdown", () => {
    const box = html("## Overview\n\nSome **bold** words.");
    expect(box.querySelector("h2")?.textContent).toBe("Overview");
    expect(box.querySelector("p strong")?.textContent).toBe("bold");
  });

  it("removes scripts, event handlers and javascript: links", () => {
    const box = html(
      'Hi <script>alert(1)</script><img src="x" onerror="alert(2)">\n\n[click](javascript:alert(3))',
    );
    expect(box.querySelector("script")).toBeNull();
    expect(box.querySelector("img")?.getAttribute("onerror")).toBeNull();
    expect(box.querySelector("a")?.getAttribute("href") ?? "").not.toMatch(/javascript/i);
  });

  it("gives each block the direction of its own text", () => {
    const box = html("## סיכום השיעור\n\nThe overview in English.\n\n- `00:01:10` מה זה מקרה שימוש\n- `00:05:00` Actors\n\nملخص الدرس");
    expect(box.querySelector("h2")?.getAttribute("dir")).toBe("rtl");
    const [english, arabic] = box.querySelectorAll("p");
    expect(english!.getAttribute("dir")).toBe("ltr");
    expect(arabic!.getAttribute("dir")).toBe("rtl");
    const [hebrewItem, englishItem] = box.querySelectorAll("li");
    expect(hebrewItem!.getAttribute("dir")).toBe("rtl");
    expect(englishItem!.getAttribute("dir")).toBe("ltr");
  });

  it("keeps timestamps left-to-right inside right-to-left text", () => {
    const box = html("- `00:01:10` מה זה מקרה שימוש\n\n[01:02:03] שאלות?");
    const code = box.querySelector("li code");
    expect(code?.textContent).toBe("00:01:10");
    expect(code?.getAttribute("dir")).toBe("ltr");
    const stamp = box.querySelector("p .ts");
    expect(stamp?.textContent).toBe("[01:02:03]");
    expect(stamp?.getAttribute("dir")).toBe("ltr");
    expect(box.querySelector("p")?.getAttribute("dir")).toBe("rtl");
  });
});
