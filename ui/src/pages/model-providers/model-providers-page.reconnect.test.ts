/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { loginHarness } from "./model-providers-page.login.test-support.ts";
import {
  appendPage,
  createAuthStatus,
  expandProvider,
  submitCredential,
} from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function reconnectHarness(kinds: ("oauth" | "device-code" | "secret")[]) {
  const health = createAuthStatus([
    {
      provider: "xai",
      displayName: "xAI",
      status: "expired",
      profiles: [{ profileId: "xai:expired", type: "oauth", status: "expired" }],
    },
  ]);
  const capabilities = [
    {
      provider: "xai",
      apiKeySupported: true,
      quickApiKeySetup: true,
      loginOptions: kinds.map((kind, index) => ({
        id: `xai/method-${index}`,
        brandId: "xai",
        label: `xAI ${kind}`,
        kind,
        featured: kind !== "secret",
      })),
    },
  ];
  return loginHarness({ providers: health.providers, capabilities });
}

it.each(["oauth", "device-code"] as const)(
  "reconnects an expired account using its advertised %s route without the picker",
  async (kind) => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { context, request, answer } = reconnectHarness(["secret", kind]);
    const original = request.getMockImplementation()!;
    let restored = false;
    request.mockImplementation(async (method, ...args) => {
      if (method === "models.authStatus" && restored) {
        return createAuthStatus([
          {
            provider: "xai",
            displayName: "xAI",
            profiles: [{ profileId: "xai:restored", type: "oauth", status: "ok" }],
          },
        ]);
      }
      return original(method, ...args);
    });
    const page = appendPage(context);
    const row = await expandProvider(page, "xai");
    const reconnect = row.querySelector<HTMLButtonElement>(".model-providers__profile-reconnect");
    expect(reconnect?.disabled).toBe(false);
    reconnect!.click();
    await waitForSolid(() =>
      expect(page.querySelector<HTMLInputElement>('input[name="wizard-text"]')?.disabled).toBe(
        false,
      ),
    );
    expect(page.querySelector("[data-models-login-choice]")).toBeNull();
    expect(request).toHaveBeenCalledWith(
      "models.authLogin",
      { sessionId: expect.any(String), authChoice: "xai/method-1", agentId: "writer" },
      { timeoutMs: null },
    );
    expect(reconnect?.disabled).toBe(true);
    restored = true;
    answer.resolve({ done: true, status: "done" });
    await submitCredential(page);
    await waitForSolid(() =>
      expect(page.renderRoot.textContent).toContain("Provider credentials saved."),
    );
    const close = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Close",
    );
    expect(close).toBeDefined();
    close!.click();
    await page.updateComplete;
    const restoredRow = await expandProvider(page, "xai");
    await waitForSolid(() =>
      expect(page.querySelector('[data-profile-id="xai:restored"]')).not.toBeNull(),
    );
    expect(restoredRow.querySelector(".model-providers__profile-reconnect")).toBeNull();
  },
);

it.each([
  { name: "no OAuth route", kinds: ["secret"] as const },
  { name: "ambiguous OAuth routes", kinds: ["oauth", "device-code"] as const },
])("does not guess a reconnect method with $name", async ({ kinds }) => {
  const { context, request } = reconnectHarness([...kinds]);
  const page = appendPage(context);
  const row = await expandProvider(page, "xai");
  expect(row.querySelector(".model-providers__profile-reconnect")).toBeNull();
  expect(request.mock.calls.filter(([method]) => method === "models.authLogin")).toHaveLength(0);
});
