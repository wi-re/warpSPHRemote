import { profile } from "./profiles";
self.onmessage = ({ data }) => {
  try {
    self.postMessage({
      result: profile(data.frame, data.settings, data.domain),
    });
  } catch (e) {
    self.postMessage({ error: (e as Error).message });
  }
};
