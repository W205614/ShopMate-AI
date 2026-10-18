import { HttpError } from "./auth";
/** Missing versions are accepted only for deprecated internal/legacy callers. */
export function checkVersion(current: { version?: number }, expected?: number) {
  if (expected !== undefined && expected !== (current.version ?? 1))
    throw new HttpError(409, "记录已被其他页面修改，请加载最新版本后重新编辑");
}
