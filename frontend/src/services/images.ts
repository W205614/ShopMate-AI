import { validateImages } from "../../../shared/domain/images";
import { request, getSession } from "./repository";

const uploadedSizes = new Map<string, number>();
export const uploadedImageBytes = (source: string) => uploadedSizes.get(source);

export async function uploadProductImage(file: File) {
  const actor = getSession("admin")?.id;
  if (!actor) throw new Error("请先登录管理端");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const fingerprint = Array.from(digest, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  const key = `shopmate:asset-upload:${actor}:${fingerprint}`;
  const requestId = sessionStorage.getItem(key) ?? crypto.randomUUID();
  sessionStorage.setItem(key, requestId);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 16384)
    binary += String.fromCharCode(...bytes.subarray(at, at + 16384));
  const result = await request<{ id: string; url: string; bytes: number }>(
    "/api/assets",
    { requestId, contentBase64: btoa(binary) },
  );
  if (getSession("admin")?.id !== actor)
    throw new Error("登录身份已变化，请重新核对图片");
  sessionStorage.removeItem(key);
  uploadedSizes.set(result.url, result.bytes);
  return result.url;
}
export async function validateDecodedImages(images: string[], maximum = 12) {
  validateImages(images, maximum);
  await Promise.all(
    images.map(async (source) => {
      const image = new Image();
      image.src = source;
      try {
        await image.decode();
      } catch {
        throw new Error(
          "图片无法解码，请使用有效的 PNG/JPEG/WebP 文件或内置图片路径",
        );
      }
    }),
  );
}
