import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Socket } from "node:net";
import { createClamAvDaemonScanner, MEDIA_LIMITS } from "./media";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const version = "ClamAV 1.5.4/28157/Sun Oct 18 06:24:14 2026";

/** Controlled wire fixtures exercise framing, never pretend to scan malware. */
async function protocolFixture(reply: string | null, versionReply = version, timeoutMs = 15_000) {
  const sockets = new Set<Socket>();
  const bodies: Buffer[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    let command = "";
    let body = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!command) {
        const end = buffered.indexOf(0);
        if (end < 0) return;
        command = buffered.subarray(0, end).toString();
        buffered = buffered.subarray(end + 1);
        if (command === "zVERSION") {
          socket.end(`${versionReply}\0`);
          return;
        }
      }
      if (command !== "zINSTREAM") return;
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0);
        if (buffered.length < length + 4) return;
        buffered = buffered.subarray(4);
        if (length === 0) {
          bodies.push(body);
          if (reply !== null) socket.end(`${reply}\0`);
          return;
        }
        body = Buffer.concat([body, buffered.subarray(0, length)]);
        buffered = buffered.subarray(length);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  return {
    scanner: createClamAvDaemonScanner({
      host: "127.0.0.1",
      port: address.port,
      timeoutMs,
    }),
    bodies,
  };
}

describe("ClamAV daemon protocol boundary", () => {
  it("frames bounded binary chunks exactly and accepts only a complete clean reply", async () => {
    const fixture = await protocolFixture("stream: OK");
    const bytes = Buffer.alloc(150_000, 73);
    expect(
      await fixture.scanner.scan(bytes, {
        mimeType: "image/png",
        sha256: "fixture",
      }),
    ).toEqual({ verdict: "clean", engine: "clamav:1.5.4/db:28157" });
    expect(fixture.bodies).toHaveLength(1);
    expect(fixture.bodies[0]).toEqual(bytes);
  });
  it("distinguishes a detection from malformed, error and contaminated replies", async () => {
    for (const [reply, verdict] of [
      ["stream: Win.Test.EICAR FOUND", "rejected"],
      ["INSTREAM size limit exceeded. ERROR", "unavailable"],
      ["stream: OK\nnot a clean response", "unavailable"],
      ["stream: OK\0extra", "unavailable"],
    ] as const) {
      const fixture = await protocolFixture(reply);
      expect(
        (
          await fixture.scanner.scan(Buffer.from("controlled wire fixture"), {
            mimeType: "image/png",
            sha256: "fixture",
          })
        ).verdict,
      ).toBe(verdict);
    }
  });
  it("refuses unidentified engines and never submits the private bytes to them", async () => {
    const fixture = await protocolFixture(
      "stream: OK",
      "some arbitrary successful server",
    );
    expect(
      (
        await fixture.scanner.scan(Buffer.from("private fixture"), {
          mimeType: "image/png",
          sha256: "fixture",
        })
      ).verdict,
    ).toBe("unavailable");
    expect(fixture.bodies).toHaveLength(0);
  });
  it("times out a hung daemon and rejects oversize input before transport", async () => {
    const fixture = await protocolFixture(null, version, 50);
    expect(
      (
        await fixture.scanner.scan(Buffer.from("fixture"), {
          mimeType: "image/png",
          sha256: "fixture",
        })
      ).verdict,
    ).toBe("unavailable");
    const submittedBeforeOversize = fixture.bodies.length;
    expect(
      (
        await fixture.scanner.scan(Buffer.alloc(MEDIA_LIMITS.maxBytes + 1), {
          mimeType: "image/png",
          sha256: "fixture",
        })
      ).verdict,
    ).toBe("unavailable");
    expect(submittedBeforeOversize).toBeLessThanOrEqual(1);
    expect(fixture.bodies).toHaveLength(submittedBeforeOversize);
  });
  it("requires exactly one explicit daemon endpoint", () => {
    expect(() =>
      createClamAvDaemonScanner({ host: "127.0.0.1", port: 0 }),
    ).toThrow();
    expect(() =>
      createClamAvDaemonScanner({ socketPath: "relative.sock" }),
    ).toThrow();
    expect(() =>
      createClamAvDaemonScanner({
        socketPath: "/tmp/clamd.sock",
        host: "127.0.0.1",
        port: 3310,
      }),
    ).toThrow();
  });
});
