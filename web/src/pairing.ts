import { companionEndpoint } from "./companion";

export interface SavedPairing {
  endpoint: string;
  token: string;
}
const key = "warpsph-companion-pairing-v1";
export function recallPairing(): SavedPairing | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!value || typeof value.token !== "string" || !value.token.trim())
      return null;
    return {
      endpoint: companionEndpoint(value.endpoint),
      token: value.token.trim(),
    };
  } catch {
    return null;
  }
}
export function rememberPairing(value: SavedPairing): boolean {
  try {
    const endpoint = companionEndpoint(value.endpoint),
      token = value.token.trim();
    if (!token) return false;
    localStorage.setItem(key, JSON.stringify({ endpoint, token }));
    return true;
  } catch {
    return false;
  }
}
export function forgetPairing(): boolean {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
/** A saved token must not follow an edited address to a different server. */
export function samePairingEndpoint(
  saved: SavedPairing,
  input: string,
): boolean {
  try {
    return saved.endpoint === companionEndpoint(input);
  } catch {
    return false;
  }
}
