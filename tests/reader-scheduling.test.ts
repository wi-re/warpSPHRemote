import test from "node:test";
import assert from "node:assert/strict";
import { BrowserSource } from "../web/src/sources/client";
test("temporal jobs yield to foreground frames, queued work cancels, and closed sources reject", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  let worker: FakeWorker;
  class FakeWorker {
    onmessage: ((event: any) => void) | undefined;
    onerror: ((event: any) => void) | undefined;
    messages: any[] = [];
    terminated = false;
    constructor() {
      worker = this;
    }
    postMessage(job: any) {
      this.messages.push(job);
      if (job.operation === "open")
        queueMicrotask(() => this.finish({ id: "s", frames: 10 }));
    }
    finish(result: any) {
      const job = this.messages.shift()!;
      this.onmessage?.({ data: { id: job.id, result } });
    }
    terminate() {
      this.terminated = true;
    }
  }
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: FakeWorker,
  });
  try {
    const reader = await BrowserSource.open([], 2, "s"),
      cancel = new AbortController();
    const material = reader.material(0, 1, ["9007199254740993"]),
      queued = reader.material(1, 1, ["9007199254740993"], cancel.signal),
      foreground = reader.frame(9, "densities");
    const cancelled = assert.rejects(queued, { name: "AbortError" });
    cancel.abort();
    await cancelled;
    assert.equal(worker!.messages[0].operation, "material");
    assert.equal(worker!.messages[0].args.uids[0], "9007199254740993");
    worker!.finish([]);
    await material;
    assert.equal(worker!.messages[0].operation, "frame");
    worker!.finish({ index: 9 });
    assert.equal((await foreground).index, 9);
    assert.equal(worker!.messages.length, 0);
    reader.close();
    assert.ok(worker!.terminated);
    await assert.rejects(reader.material(2, 1, ["1"]), /closed/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "Worker", previous);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});
