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

  it("no warning at or under the cap, or when copying isn't configured", () => {
    for (const [s, c] of [["5.00", "5"], ["2.00", "5"], ["50.00", null]] as const)
      expect(render(s, c)).not.toContain("Copies are refused");
  });
});
