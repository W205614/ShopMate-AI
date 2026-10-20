import type { APIRequestContext } from "@playwright/test";
import { readHttpSnapshot } from "../../shared/testing/http-snapshot.mjs";

export function readSnapshot(request: APIRequestContext, role = "user") {
  return readHttpSnapshot(async (path) => {
    const response = await request.get(path);
    if (!response.ok())
      throw new Error(`${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  }, role);
}
