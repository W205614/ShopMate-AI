import {
  getSession,
  request,
  requireFreshState,
  RequestError,
} from "./repository";

export interface SupportDocument {
  id: string;
  name: string;
  status:
    | "queued"
    | "extracting"
    | "indexing"
    | "draft"
    | "published"
    | "disabled"
    | "failed";
  version: number;
  publishedVersion: number | null;
  text: string;
  error: string | null;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
  bytes: number;
}
export const processingDocument = (document: SupportDocument) =>
  ["queued", "extracting", "indexing"].includes(document.status);
export const documentLabels: Record<SupportDocument["status"], string> = {
  queued: "排队中",
  extracting: "识别中",
  indexing: "索引中",
  draft: "草稿待发布",
  published: "已发布",
  disabled: "已停用",
  failed: "处理失败",
};
// Keep the same id on retries after an unknown response, including a page reload.
export async function documentCommand<T>(
  path: string,
  input: Record<string, unknown>,
): Promise<T> {
  requireFreshState();
  const actor = getSession("admin")?.id;
  if (!actor) throw Error("请登录管理端后操作");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([actor, path, input])),
  );
  const key =
    "shopmate:document-command:" +
    Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  if (getSession("admin")?.id !== actor)
    throw Error("登录身份已变化，请重新核对后操作");
  const requestId = sessionStorage.getItem(key) ?? crypto.randomUUID();
  sessionStorage.setItem(key, requestId);
  try {
    const result = await request<T>(path, { ...input, requestId });
    sessionStorage.removeItem(key);
    return result;
  } catch (error) {
    if (error instanceof RequestError && error.outcome === "rejected")
      sessionStorage.removeItem(key);
    throw error;
  }
}
