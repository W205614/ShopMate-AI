import { validateImages } from "../../../shared/domain/images";
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
