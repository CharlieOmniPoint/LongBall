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
    uri = "file://cache/report-opaque-export-id.json";
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
    expect(mocks.write).toHaveBeenCalledWith(artifact.body);
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
