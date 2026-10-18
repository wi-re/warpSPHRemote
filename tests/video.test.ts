import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webm } from "../web/src/video";

test("WebM plays and seeks VP8 frames with fixed timestamps independent of capture delays", (t) => {
  if (
    spawnSync("ffmpeg", ["-version"]).status !== 0 ||
    spawnSync("ffprobe", ["-version"]).status !== 0
  ) {
    t.skip("ffmpeg and ffprobe are optional interoperability tools");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "warpsph-video-test-"));
  try {
    const input = join(root, "input.ivf"),
      out = join(root, "output.webm");
    const generated = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=32x32:rate=30",
      "-frames:v",
      "4",
      "-c:v",
      "libvpx",
      "-g",
      "1",
      "-f",
      "ivf",
      input,
    ]);
    assert.equal(generated.status, 0, generated.stderr?.toString());
    const raw = readFileSync(input),
      chunks = [];
    let offset = 32;
    for (let i = 0; offset < raw.length; i++) {
      const length = raw.readUInt32LE(offset);
      offset += 12;
      chunks.push({
        data: new Uint8Array(raw.subarray(offset, offset + length)),
        timestamp: (i * 1_000_000) / 30,
        key: true,
      });
      offset += length;
    }
    writeFileSync(out, webm(chunks, 32, 32, 30));
    const probe = spawnSync("ffprobe", [
      "-v",
      "error",
      "-count_frames",
      "-show_entries",
      "stream=codec_name,width,height,nb_read_frames,avg_frame_rate",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      out,
    ]);
    assert.equal(probe.status, 0, probe.stderr?.toString());
    const info = JSON.parse(probe.stdout.toString());
    assert.equal(info.streams[0].nb_read_frames, "4");
    assert.equal(info.streams[0].avg_frame_rate, "30/1");
    assert.ok(Math.abs(Number(info.format.duration) - 4 / 30) < 0.001);
    const seek = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-ss",
      "0.07",
      "-i",
      out,
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ]);
    assert.equal(seek.status, 0, seek.stderr?.toString());
    // A cluster per frame keeps the signed Block timecode valid after 32 seconds.
    const long = join(root, "long.webm");
    writeFileSync(
      long,
      webm(
        chunks.map((c, i) => ({ ...c, timestamp: i * 40_000_000 })),
        32,
        32,
        1 / 40,
      ),
    );
    const late = spawnSync("ffprobe", [
      "-v",
      "error",
      "-count_frames",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "json",
      long,
    ]);
    assert.equal(
      JSON.parse(late.stdout.toString()).streams[0].nb_read_frames,
      "4",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
