import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { executeImageDecoder, imageProcessRejected } from "./image-process";

const execute = promisify(execFile),
  directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function failure(work: Promise<unknown>) {
  try {
    await work;
    throw new Error("Expected controlled process failure");
  } catch (error) {
    return error;
  }
}

describe("bounded decoder process outcomes", () => {
  it("distinguishes actual timeout, crash, missing executable and unknown failure from an explicit rejection", async () => {
    const timeout = await failure(
      execute(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        timeout: 100,
        killSignal: "SIGKILL",
      }),
    );
    expect(timeout).toMatchObject({ killed: true, signal: "SIGKILL" });
    expect(imageProcessRejected(timeout)).toBe(false);
    const crash = await failure(
      execute(process.execPath, ["-e", "process.kill(process.pid,'SIGKILL')"]),
    );
    expect(crash).toMatchObject({ signal: "SIGKILL" });
    expect(imageProcessRejected(crash)).toBe(false);
    expect(
      imageProcessRejected(
        await failure(execute("/longball-test/no-decoder-installed", [])),
      ),
    ).toBe(false);
    expect(
      imageProcessRejected(
        await failure(execute(process.execPath, ["-e", "process.exit(2)"])),
      ),
    ).toBe(false);
    expect(imageProcessRejected({ code: 1, stderr: "unexpected error" })).toBe(
      false,
    );
    expect(
      imageProcessRejected({
        code: 1,
        stderr: "IMAGE_DECODE_REJECTED",
        signal: "SIGKILL",
      }),
    ).toBe(false);
  });
  it("accepts only the real worker content rejection marker and treats worker filesystem failure as unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "longball-image-process-"));
    directories.push(directory);
    const input = join(directory, "input.png"),
      display = join(directory, "display.jpg"),
      thumbnail = join(directory, "thumbnail.jpg");
    const args = [
      "--max-old-space-size=128",
      fileURLToPath(new URL("./media-worker.mjs", import.meta.url)),
      input,
      display,
      thumbnail,
      "image/png",
      "photo",
    ];
    await writeFile(input, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const rejected = await failure(executeImageDecoder(args, 12_000));
    expect(rejected).toMatchObject({
      code: 1,
      stderr: "IMAGE_DECODE_REJECTED",
    });
    expect(imageProcessRejected(rejected)).toBe(true);
    const valid = await sharp({
      create: { width: 16, height: 12, channels: 3, background: "#176b45" },
    })
      .png()
      .toBuffer();
    await writeFile(input, valid);
    const inaccessibleOutput = [...args];
    inaccessibleOutput[3] = join(directory, "absent", "display.jpg");
    const unavailable = await failure(
      executeImageDecoder(inaccessibleOutput, 12_000),
    );
    expect(unavailable).toMatchObject({
      code: 2,
      stderr: "MEDIA_PROCESSING_FAILED",
    });
    expect(imageProcessRejected(unavailable)).toBe(false);
  });
});
