import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  rememberFiles,
  recallFiles,
  forgetFiles,
  fileKey,
} from "../web/src/session";
test("remembered local files survive a fresh read, preserve bytes/names, replace atomically and can be forgotten", async () => {
  await forgetFiles();
  assert.equal(await recallFiles(), null);
  const original = [
    new File([new Uint8Array([1, 2, 255])], "recording.h5", {
      lastModified: 17,
    }),
    new File(["{}"], "metadata.json", { lastModified: 18 }),
  ];
  await rememberFiles(original);
  const saved = await recallFiles();
  assert.equal(saved?.key, fileKey(original));
  assert.deepEqual(await saved!.files[0].bytes(), new Uint8Array([1, 2, 255]));
  assert.equal(saved!.files[0].lastModified, 17);
  const replacement = [new File(["new"], "other.npz", { lastModified: 21 })];
  await rememberFiles(replacement);
  const next = await recallFiles();
  assert.equal(next!.files.length, 1);
  assert.equal(next!.files[0].name, "other.npz");
  assert.equal(await next!.files[0].text(), "new");
  await forgetFiles();
  assert.equal(await recallFiles(), null);
});
