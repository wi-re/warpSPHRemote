/// <reference lib="webworker" />
import { runChecks } from "./checks";
self.onmessage = async () => {
  try {
    await runChecks((row) => self.postMessage({ row }));
    self.postMessage({ done: true });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
