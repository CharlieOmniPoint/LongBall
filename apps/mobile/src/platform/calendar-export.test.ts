import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliverCalendarExport } from "./calendar-export";
const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  share: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  exists: false,
}));
vi.mock("expo-sharing", () => ({
  isAvailableAsync: mocks.available,
  shareAsync: mocks.share,
}));
vi.mock("./id", () => ({ randomUUID: () => "opaque-calendar" }));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file://cache" },
  Directory: class {
    create() {}
  },
  File: class {
    uri = "file://cache/calendar-opaque-calendar.ics";
    get exists() {
      return mocks.exists;
    }
    create() {
      mocks.exists = true;
    }
    write = mocks.write;
    delete() {
      mocks.exists = false;
      mocks.remove();
    }
  },
}));
const artifact = {
  fileName: "longball-calendar.ics",
  contentType: "text/calendar; charset=utf-8" as const,
  body: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.exists = false;
  mocks.available.mockResolvedValue(true);
  mocks.share.mockResolvedValue(undefined);
});
describe("native calendar file authority and cleanup", () => {
  it("deletes the private temporary file when access closes during the write and never opens Sharing", async () => {
    const access = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("session closed"));
    await expect(deliverCalendarExport(artifact, access)).rejects.toThrow(
      /session closed/,
    );
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.exists).toBe(false);
  });
  it("uses the calendar MIME and removes the app copy after success or native failure", async () => {
    await deliverCalendarExport(artifact, async () => {});
    expect(mocks.share).toHaveBeenCalledWith(
      "file://cache/calendar-opaque-calendar.ics",
      expect.objectContaining({ mimeType: "text/calendar" }),
    );
    expect(mocks.remove).toHaveBeenCalledOnce();
    mocks.share.mockRejectedValueOnce(new Error("cancelled"));
    await expect(
      deliverCalendarExport(artifact, async () => {}),
    ).rejects.toThrow(/cancelled/);
    expect(mocks.remove).toHaveBeenCalledTimes(2);
  });
  it("rejects an unsafe filename before creating a file", async () => {
    await expect(
      deliverCalendarExport(
        { ...artifact, fileName: "../child-name.ics" },
        async () => {},
      ),
    ).rejects.toThrow(/invalid/);
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.exists).toBe(false);
  });
});
