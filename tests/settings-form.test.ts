/** H-05: a saved max stake above the server's cap is called out in Settings (it's refused, not clamped). */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
const { SettingsForm } = await import("@/components/SettingsForm");

const render = (maxStakeUsdc: string, capUsdc: string | null) =>
  renderToStaticMarkup(
    createElement(SettingsForm, { initial: { maxStakeUsdc, slippageBps: 200, alertsEnabled: true }, capUsdc }),
  );

describe("SettingsForm and the launch cap (H-05)", () => {
  it("warns when the saved stake is above the cap", () => {
    const html = render("50.00", "5");
    expect(html).toContain("role=\"alert\"");
    expect(html).toMatch(/above this server(&#x27;|&apos;|')s limit of 5 USDC/);
    expect(html).toContain("Copies are refused until you lower it");
  });

  it("Q-01: the help text starts at 2 USDC", () => {
    expect(render("5.00", "5")).toContain("2–5 USDC (this server");
    expect(render("5.00", null)).toContain("2–1000 USDC.");
    expect(render("5.00", "5")).not.toContain("1–5 USDC");
    // 1.50 saved before Q-01: the field shows as invalid
    expect(render("1.50", "5")).toContain('aria-invalid="true"');
    expect(render("2.00", "5")).toContain('aria-invalid="false"');
  });

  it("no warning at or under the cap, or when copying isn't configured", () => {
    for (const [s, c] of [["5.00", "5"], ["2.00", "5"], ["50.00", null]] as const)
      expect(render(s, c)).not.toContain("Copies are refused");
  });
});
