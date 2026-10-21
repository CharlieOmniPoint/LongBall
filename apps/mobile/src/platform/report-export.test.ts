import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliverReportExport } from "./report-export";

const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  share: vi.fn(),
  createDirectory: vi.fn(),
  create: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  exists: false,
}));
vi.mock("expo-sharing", () => ({
  isAvailableAsync: mocks.available,
  shareAsync: mocks.share,
}));
vi.mock("./id", () => ({ randomUUID: () => "opaque-export-id" }));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file://cache" },
  Directory: class {
    create = mocks.createDirectory;
  },
  File: class {
    uri: string;
    constructor(...parts: unknown[]) { this.uri = `file://cache/${parts.at(-1)}`; }
    get exists() {
      return mocks.exists;
    }
    create() {
      mocks.exists = true;
      mocks.create();
    }
    write = mocks.write;
    delete() {
      mocks.exists = false;
      mocks.remove();
    }
  },
}));
const artifact = {
  fileName: "longball-report.json",
  contentType: "application/json",
  body: '{"audience":"player"}',
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.exists = false;
  mocks.available.mockResolvedValue(true);
  mocks.share.mockResolvedValue(undefined);
});
describe("native permitted report export boundary", () => {
  it("rechecks access after writing and removes the temporary private file if the session closed", async () => {
    const access = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("session closed"));
    await expect(deliverReportExport(artifact, access)).rejects.toThrow(
      "session closed",
    );
    expect(mocks.write).toHaveBeenCalledWith(new TextEncoder().encode(artifact.body));
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.exists).toBe(false);
  });
  it("removes the app copy after the native share sheet completes", async () => {
    const access = vi.fn().mockResolvedValue(undefined);
    expect(await deliverReportExport(artifact, access)).toMatch(
      /temporary export was removed/,
    );
    expect(access).toHaveBeenCalledTimes(2);
    expect(mocks.share).toHaveBeenCalledWith(
      "file://cache/report-opaque-export-id.json",
      expect.objectContaining({ mimeType: "application/json" }),
    );
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it("removes a private file even when the native share operation fails", async () => {
    mocks.share.mockRejectedValueOnce(new Error("share unavailable"));
    await expect(deliverReportExport(artifact, async () => {})).rejects.toThrow(
      "share unavailable",
    );
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it("shares real PDF bytes with the platform PDF type and always removes the app cache copy", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nBinary report fixture\n%%EOF\n");
    await deliverReportExport({ fileName: "longball-report-safe.pdf", contentType: "application/pdf", bytes }, async () => {});
    expect(mocks.write).toHaveBeenCalledWith(bytes);
    expect(mocks.share).toHaveBeenCalledWith("file://cache/report-opaque-export-id.pdf", expect.objectContaining({ mimeType: "application/pdf", UTI: "com.adobe.pdf" }));
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it("rejects a renamed HTML/text file or oversized binary before creating a private file", async () => {
    for (const bytes of [new TextEncoder().encode("<html>not a PDF</html>"), new Uint8Array(5 * 1024 * 1024 + 1)]) {
      await expect(deliverReportExport({ fileName: "longball-report-safe.pdf", contentType: "application/pdf", bytes }, async () => {})).rejects.toThrow(/invalid/);
    }
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.share).not.toHaveBeenCalled();
  });
  it("rejects invalid filenames and unavailable share destinations before creating a file", async () => {
    await expect(
      deliverReportExport(
        { ...artifact, fileName: "../private.json" },
        async () => {},
      ),
    ).rejects.toThrow(/invalid/);
    mocks.available.mockResolvedValueOnce(false);
    await expect(deliverReportExport(artifact, async () => {})).rejects.toThrow(
      /destination/,
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
