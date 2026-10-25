import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectedSession,
  PinRecord,
} from "@longball/application/security";
import * as webVault from "./vault.web";

afterEach(async () => {
  await webVault.clearCredential();
  vi.unstubAllGlobals();
});
describe("Connected browser credential boundary", () => {
  it("keeps credentials in memory without writing browser persistence or the synthetic journal", async () => {
    const localWrite = vi.fn(),
      indexedOpen = vi.fn();
    vi.stubGlobal("localStorage", { setItem: localWrite });
    vi.stubGlobal("indexedDB", { open: indexedOpen });
    const credential = {
      version: 1,
      source: "oidc_code_pkce",
      accessToken: "fictional-test-token",
      refreshToken: "fictional-test-refresh",
    } as ConnectedSession;
    await webVault.writeCredential(credential);
    expect((await webVault.readCredential())?.accessToken).toBe(
      "fictional-test-token",
    );
    expect(localWrite).not.toHaveBeenCalled();
    expect(indexedOpen).not.toHaveBeenCalled();
    await webVault.clearCredential();
    expect(await webVault.readCredential()).toBeNull();
  });
  it("does not pretend to persist a native local unlock PIN in the browser", async () => {
    expect(webVault.credentialStorage).toBe("memory-browser");
    expect(await webVault.readPin("account")).toBeNull();
    await expect(webVault.writePin({} as PinRecord)).rejects.toThrow(
      /native development build/,
    );
  });
});
