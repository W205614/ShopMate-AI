import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import mammoth from "mammoth";
import sharp from "sharp";
import { aiConfig, embed, vision, ProviderError } from "./ai-provider";

export interface DocumentSection {
  text: string;
  page?: number;
  paragraph?: number;
}
export interface KnowledgeChunk extends DocumentSection {
  tokens: string;
  vector: Buffer;
}
const exec = promisify(execFile);
const maxText = 1_000_000;
const cancellation = new AbortController();
if (process.env.AI_DOCUMENT_WORKER === "1")
  process.on("SIGTERM", () => cancellation.abort());

export function tokenize(value: string): string {
  // Intl word boundaries retain Chinese words; bigrams improve name/partial phrase recall.
  const segments = [
    ...new Intl.Segmenter("zh", { granularity: "word" }).segment(
      value.toLowerCase(),
    ),
  ]
    .filter((s) => s.isWordLike)
    .map((s) => s.segment);
  for (const run of value.match(/[\p{Script=Han}]{2,}/gu) ?? [])
    for (let i = 0; i < run.length - 1; i++) segments.push(run.slice(i, i + 2));
  return [...new Set(segments)]
    .map((s) => s.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean)
    .join(" ");
}

export function splitSections(sections: DocumentSection[]): DocumentSection[] {
  const chunks: DocumentSection[] = [];
  for (const section of sections) {
    const paragraphs = section.text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    // OCR often emits one short paragraph per line. Keep adjacent facts and their
    // subject together; only long sections need overlapping windows.
    const text = paragraphs.join("\n\n");
    const starts: number[] = [];
    let position = 0;
    for (const paragraph of paragraphs) {
      starts.push(position);
      position += paragraph.length + 2;
    }
    let paragraphIndex = 0;
    for (let offset = 0; offset < text.length; offset += 500) {
      while (
        paragraphIndex + 1 < starts.length &&
        starts[paragraphIndex + 1]! <= offset
      )
        paragraphIndex++;
      chunks.push({
        text: text.slice(offset, offset + 600),
        ...(section.page ? { page: section.page } : {}),
        paragraph: (section.paragraph ?? 1) + paragraphIndex,
      });
      if (offset + 600 >= text.length) break;
    }
  }
  if (!chunks.length) throw new Error("DOCUMENT_EMPTY_TEXT");
  if (chunks.length > 6000) throw new Error("DOCUMENT_CHUNK_LIMIT");
  return chunks;
}

function validateDocx(buffer: Buffer) {
  // Reject ZIP64 and oversized expanded archives before Mammoth inflates content.
  let eocd = -1;
  for (let p = buffer.length - 22; p >= Math.max(0, buffer.length - 65557); p--)
    if (buffer.readUInt32LE(p) === 0x06054b50) {
      eocd = p;
      break;
    }
  if (eocd < 0) throw new Error("DOCUMENT_INVALID_DOCX");
  const count = buffer.readUInt16LE(eocd + 10),
    start = buffer.readUInt32LE(eocd + 16);
  if (count > 2000 || start >= eocd) throw new Error("DOCUMENT_ARCHIVE_LIMIT");
  let expanded = 0,
    cursor = start;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("DOCUMENT_INVALID_DOCX");
    expanded += buffer.readUInt32LE(cursor + 24);
    if (expanded > 64 * 1024 * 1024) throw new Error("DOCUMENT_ARCHIVE_LIMIT");
    cursor +=
      46 +
      buffer.readUInt16LE(cursor + 28) +
      buffer.readUInt16LE(cursor + 30) +
      buffer.readUInt16LE(cursor + 32);
  }
}

async function image(buffer: Buffer, expected?: string): Promise<Buffer> {
  const decoded = sharp(buffer, {
    limitInputPixels: 20_000_000,
    failOn: "warning",
  });
  const metadata = await decoded.metadata();
  if (
    !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
    !metadata.width ||
    !metadata.height ||
    (metadata.pages ?? 1) > 1
  )
    throw new Error("DOCUMENT_INVALID_IMAGE");
  if (expected && metadata.format !== expected)
    throw new Error("DOCUMENT_IMAGE_TYPE_MISMATCH");
  return decoded
    .resize({
      width: 2000,
      height: 2000,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
}

export async function parseDocument(
  name: string,
  raw: Buffer,
): Promise<DocumentSection[]> {
  const ext = name.split(".").pop()?.toLowerCase();
  let sections: DocumentSection[];
  if (["txt", "md", "markdown"].includes(ext ?? "")) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (text.includes("\0")) throw new Error("DOCUMENT_INVALID_TEXT");
    sections = [{ text }];
  } else if (ext === "docx") {
    validateDocx(raw);
    sections = [
      { text: (await mammoth.extractRawText({ buffer: raw })).value },
    ];
  } else if (ext === "pdf") {
    if (!raw.subarray(0, 8).toString("ascii").startsWith("%PDF-"))
      throw new Error("DOCUMENT_INVALID_PDF");
    const folder = await mkdtemp(
      join(process.env.AI_DOCUMENT_TEMP || tmpdir(), "shopmate-document-"),
    );
    try {
      const path = join(folder, "source.pdf");
      await writeFile(path, raw);
      const info = await exec("pdfinfo", [path], {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        signal: cancellation.signal,
      });
      if (/^Encrypted:\s+yes/im.test(info.stdout))
        throw new Error("DOCUMENT_ENCRYPTED_PDF");
      const pages = Number(info.stdout.match(/^Pages:\s+(\d+)/im)?.[1]);
      if (!Number.isSafeInteger(pages) || pages < 1 || pages > 30)
        throw new Error("DOCUMENT_PAGE_LIMIT");
      sections = [];
      for (let page = 1; page <= pages; page++) {
        const result = await exec(
          "pdftotext",
          [
            "-f",
            String(page),
            "-l",
            String(page),
            "-layout",
            "-enc",
            "UTF-8",
            path,
            "-",
          ],
          {
            timeout: 30000,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
            signal: cancellation.signal,
          },
        );
        let text = result.stdout.trim();
        if (text.replace(/\s/g, "").length < 20) {
          const prefix = join(folder, `page-${page}`);
          await exec(
            "pdftoppm",
            [
              "-f",
              String(page),
              "-l",
              String(page),
              "-singlefile",
              "-scale-to",
              "2000",
              "-png",
              path,
              prefix,
            ],
            {
              timeout: 30000,
              maxBuffer: 1024 * 1024,
              windowsHide: true,
              signal: cancellation.signal,
            },
          );
          text = await vision(
            await image(await readFile(prefix + ".png")),
            "image/png",
            cancellation.signal,
          );
          await rm(prefix + ".png", { force: true });
        }
        sections.push({ page, text });
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  } else if (["png", "jpg", "jpeg", "webp"].includes(ext ?? "")) {
    sections = [
      {
        page: 1,
        text: await vision(
          await image(raw, ext === "jpg" ? "jpeg" : ext),
          "image/png",
          cancellation.signal,
        ),
      },
    ];
  } else throw new Error("DOCUMENT_UNSUPPORTED_FORMAT");
  const length = sections.reduce((n, s) => n + s.text.length, 0);
  if (!length || !sections.some((s) => s.text.trim()))
    throw new Error("DOCUMENT_EMPTY_TEXT");
  if (length > maxText) throw new Error("DOCUMENT_TEXT_LIMIT");
  return sections;
}

export async function indexSections(
  sections: DocumentSection[],
  budget?: { maxChunks: number; maxVectorBytes: number },
): Promise<KnowledgeChunk[]> {
  const chunks = splitSections(sections),
    result: KnowledgeChunk[] = [];
  // Reject predictable capacity failures before spending any embedding calls.
  if (budget && chunks.length > budget.maxChunks)
    throw new Error("DOCUMENT_CORPUS_CHUNK_LIMIT");
  if (
    budget &&
    chunks.length * aiConfig().embeddingDimensions * 4 > budget.maxVectorBytes
  )
    throw new Error("DOCUMENT_CORPUS_VECTOR_LIMIT");
  for (let i = 0; i < chunks.length; i += 16) {
    const batch = chunks.slice(i, i + 16),
      vectors = await embed(
        batch.map((s) => s.text),
        cancellation.signal,
      );
    result.push(
      ...batch.map((s, n) => ({
        ...s,
        tokens: tokenize(s.text),
        vector: Buffer.from(new Float32Array(vectors[n]!).buffer),
      })),
    );
  }
  return result;
}

export function cosineRank(
  query: number[],
  rows: { id: string; vector: Uint8Array }[],
) {
  const norm = Math.sqrt(query.reduce((n, v) => n + v * v, 0));
  return rows
    .flatMap((row) => {
      if (row.vector.byteLength !== query.length * 4) return [];
      // IPC buffers may be unaligned; a copy gives a safe Float32Array backing store.
      const vector = new Float32Array(new Uint8Array(row.vector).buffer);
      let dot = 0,
        length = 0;
      for (let i = 0; i < query.length; i++) {
        dot += query[i]! * vector[i]!;
        length += vector[i]! ** 2;
      }
      const score = dot / (norm * Math.sqrt(length));
      return Number.isFinite(score) ? [{ id: row.id, score }] : [];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

export function mergeCosineRanks(
  previous: { id: string; score: number }[],
  batch: { id: string; score: number }[],
) {
  return [...previous, ...batch]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 20);
}

if (process.env.AI_DOCUMENT_WORKER === "1" && process.send)
  process.once("message", async (input: unknown) => {
    const task = input as {
      type: string;
      name: string;
      raw: Buffer;
      sections?: DocumentSection[];
      query?: number[];
      rows?: { id: string; vector: Uint8Array }[];
      maxChunks?: number;
      maxVectorBytes?: number;
    };
    try {
      if (task.type === "rank") {
        // Keep one worker alive for the query; each IPC message carries at most one DB batch.
        let best: { id: string; score: number }[] = [];
        await new Promise<void>((resolve) => {
          const accept = (raw: unknown) => {
            const message = raw as {
              rankBatch?: { id: string; vector: Uint8Array }[];
              rankDone?: boolean;
            };
            if (!Array.isArray(message.rankBatch)) return;
            if (message.rankDone) {
              process.off("message", accept);
              process.send?.({ result: best });
              resolve();
              return;
            }
            best = mergeCosineRanks(
              best,
              cosineRank(task.query!, message.rankBatch),
            );
            process.send?.({ rankReady: true });
          };
          process.on("message", accept);
          process.send?.({ rankReady: true });
        });
        return;
      }
      const sections =
        task.sections ??
        (await parseDocument(task.name, Buffer.from(task.raw)));
      process.send?.({ progress: "indexing", sections });
      const chunks = await indexSections(sections, {
        maxChunks: task.maxChunks ?? 5000,
        maxVectorBytes: task.maxVectorBytes ?? 64 * 1024 * 1024,
      });
      process.send?.({ result: { sections, chunks } });
    } catch (error) {
      const code =
        error instanceof ProviderError
          ? error.code
          : error instanceof Error && /^DOCUMENT_[A-Z_]+$/.test(error.message)
            ? error.message
            : "DOCUMENT_PROCESSING_FAILED";
      process.send?.({ error: code });
    } finally {
      process.disconnect?.();
    }
  });
