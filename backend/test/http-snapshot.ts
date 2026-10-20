import { readHttpSnapshot } from "../../shared/testing/http-snapshot.mjs";

export function readSnapshot(base: string, cookie = "", role = "user") {
  return readHttpSnapshot(async (path) => {
    const response = await fetch(base + path, { headers: { Cookie: cookie } });
    if (!response.ok)
      throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return response.json();
  }, role);
}
