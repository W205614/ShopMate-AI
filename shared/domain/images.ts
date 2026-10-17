export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGES_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 12;
export const IMAGE_MAX_ENCODED_LENGTH = Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 40;
// Public catalog assets also count toward the aggregate byte limit. A test checks these sizes.
const builtIn = new Map<string, number>(
  [
    86148, 39861, 39151, 41358, 39227, 83742, 50882, 138946, 55722, 80549,
    94521, 52493, 122382, 142233, 138781, 111024, 81439, 49638, 68861, 75041,
    48445, 31359, 64384, 154940,
  ].map(
    (bytes, i) =>
      [`/images/p${String(i + 1).padStart(2, "0")}.jpg`, bytes] as const,
  ),
);
export function imageBytes(source: string): number {
  if (builtIn.has(source)) return builtIn.get(source)!;
  if (typeof source !== "string" || source.length > IMAGE_MAX_ENCODED_LENGTH)
    throw new Error("单张图片不能超过 2 MiB");
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
  if (!match || !match[2] || match[2].length % 4 !== 0)
    throw new Error("图片须为内置 /images/ 路径或上传的 PNG/JPEG/WebP 图片");
  let bytes: string;
  try {
    bytes = atob(match[2]);
  } catch {
    throw new Error("图片编码无效");
  }
  if (btoa(bytes) !== match[2]) throw new Error("图片编码无效");
  if (bytes.length > IMAGE_MAX_BYTES) throw new Error("单张图片不能超过 2 MiB");
  const starts = (values: number[], offset = 0) =>
    values.every((value, index) => bytes.charCodeAt(offset + index) === value);
  const signature =
    match[1] === "png"
      ? bytes.length >= 24 && starts([137, 80, 78, 71, 13, 10, 26, 10])
      : match[1] === "jpeg"
        ? bytes.length >= 4 && starts([255, 216, 255])
        : bytes.length >= 16 &&
          bytes.slice(0, 4) === "RIFF" &&
          bytes.slice(8, 12) === "WEBP";
  if (!signature) throw new Error("图片内容与 PNG/JPEG/WebP 格式不匹配");
  return bytes.length;
}
export function validateImages(
  images: string[],
  maximum = IMAGE_MAX_COUNT,
): number {
  if (!images.length || images.length > maximum)
    throw new Error(`请提供 1 至 ${maximum} 张图片`);
  const total = images.reduce((sum, source) => sum + imageBytes(source), 0);
  if (total > IMAGES_MAX_BYTES) throw new Error("商品图片合计不能超过 5 MiB");
  return total;
}
