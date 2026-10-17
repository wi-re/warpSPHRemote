import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cacheDemo,
  recallDemo,
  forgetDemo,
  rememberFiles,
  forgetFiles,
} from "../web/src/session";
import {
  loadDemoFile,
  type RecordedDemo,
  type DemoStage,
} from "../web/src/recordedDemos";

const fixture = (id: string, text: string) => ({
  demo: {
    id: `demo-cache-test-${id}`,
    file: `${id}.h5`,
    name: id,
    description: "test",
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
    particles: 1,
    frames: 1,
    duration: 1,
  } satisfies RecordedDemo,
  file: new File([text], `${id}.h5`, { lastModified: 0 }),
});
test("all three demos reopen from persistent slots with zero downloads after the last recording changes or is forgotten", async () => {
  const a = fixture("random", "random bytes"),
    b = fixture("sloshing", "sloshing bytes"),
    c = fixture("khh", "khh bytes");
  await forgetDemo(a.demo.id);
  await forgetDemo(b.demo.id);
  await forgetDemo(c.demo.id);
  let downloads = 0,
    cached = 0;
  const stages: DemoStage[] = [];
  const events = {
    stage: (stage: DemoStage) => stages.push(stage),
    cached: () => cached++,
    storageIssue: (message: string) => assert.fail(message),
  };
  for (const item of [a, b, c]) {
    await loadDemoFile(
      item.demo,
      new AbortController().signal,
      events,
      async () => {
        downloads++;
        return item.file;
      },
    );
    await rememberFiles([item.file]);
  }
  assert.equal(downloads, 3);
  assert.ok(stages.includes("saving"));
  await rememberFiles([new File(["unrelated local file"], "other.h5")]);
  await forgetFiles(); // disabling last-file restoration must not evict any demo
  stages.length = 0;
  for (const item of [a, b, c]) {
    const file = await loadDemoFile(
      item.demo,
      new AbortController().signal,
      events,
      async () => {
        assert.fail("A saved demo made a network request");
      },
    );
    assert.equal(await file.text(), await item.file.text());
  }
  assert.equal(downloads, 3);
  assert.equal(cached, 6);
  assert.deepEqual(stages, [
    "checking",
    "opening",
    "checking",
    "opening",
    "checking",
    "opening",
  ]);
  await forgetDemo(a.demo.id);
  assert.equal(await recallDemo(a.demo), null);
  assert.ok(await recallDemo(b.demo));
  assert.ok(await recallDemo(c.demo));
  await forgetDemo(b.demo.id);
  await forgetDemo(c.demo.id);
});
test("catalogue revisions invalidate saved demos, while invalid bytes never replace a good cached version", async () => {
  const old = fixture("versioned", "version one"),
    updated = fixture("versioned", "version two");
  await cacheDemo(old.demo, old.file);
  assert.equal(await recallDemo(updated.demo), null); // same filename and size, different hash
  await assert.rejects(cacheDemo(old.demo, updated.file), /version/);
  assert.equal(await (await recallDemo(old.demo))!.text(), "version one");
  let downloads = 0;
  await loadDemoFile(
    updated.demo,
    new AbortController().signal,
    {
      stage: () => {},
      cached: () => {},
      storageIssue: (message) => assert.fail(message),
    },
    async () => {
      downloads++;
      return updated.file;
    },
  );
  assert.equal(downloads, 1);
  assert.equal(await recallDemo(old.demo), null);
  assert.equal(await (await recallDemo(updated.demo))!.text(), "version two");
  await forgetDemo(old.demo.id);
});
