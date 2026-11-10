import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { format, getFileInfo, resolveConfig } from "prettier";

process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
const write = process.argv.includes("--write");
const repositoryOnly = process.argv.includes("--tracked");
const args = ["ls-files", "--cached", "--deduplicate", "-z"];
if (!repositoryOnly) args.push("--others", "--exclude-standard");
const paths = new Set(
  execFileSync("git", args, { encoding: "utf8" }).split("\0").filter(Boolean),
);
// This machine's active Compose override is ignored via .git/info/exclude.
if (!repositoryOnly) paths.add("compose.override.yaml");

const pythonFiles = [];
let checked = 0;
for (const filepath of paths) {
  const basic =
    /(?:^|\/)(?:Dockerfile|\.gitignore|\.gitattributes|\.dockerignore|\.prettierignore|\.env\.example|nginx\.conf|requirements-format\.txt)$/.test(
      filepath,
    );
  const python = filepath.endsWith(".py");
  if (
    !basic &&
    !python &&
    !/\.(?:[cm]?[jt]sx?|vue|css|jsonc?|ya?ml|html|md|svg)$/.test(filepath)
  )
    continue;
  if (/(?:^|\/)(?:credentials?|secrets?)(?:[./]|$)/i.test(filepath)) continue;
  const { ignored } = await getFileInfo(filepath, {
    ignorePath: ".prettierignore",
    resolveConfig: false,
  });
  if (ignored) continue;
  const file = await open(
    filepath,
    (write ? constants.O_RDWR : constants.O_RDONLY) |
      (constants.O_NOFOLLOW ?? 0),
  ).catch((error) => {
    if (!["ENOENT", "EISDIR", "ELOOP"].includes(error.code)) throw error;
  });
  if (!file) continue;
  try {
    if (
      !(await file.stat()).isFile() ||
      (await lstat(filepath)).isSymbolicLink()
    )
      continue;
    if (python) {
      pythonFiles.push(filepath);
      continue;
    }
    const source = (await file.readFile("utf8")).replaceAll("\r\n", "\n");
    const formatted = basic
      ? source.replace(/[ \t]+$/gm, "").replace(/\n*$/, "\n")
      : await format(source, { ...(await resolveConfig(filepath)), filepath });
    if (formatted !== source) {
      console.log(filepath);
      if (write) {
        const bytes = Buffer.from(formatted);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await file.write(
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          if (!bytesWritten)
            throw new Error(`Incomplete format write: ${filepath}`);
          offset += bytesWritten;
        }
        await file.truncate(bytes.length);
      } else process.exitCode = 1;
    }
    checked++;
  } finally {
    await file.close();
  }
}
if (pythonFiles.length) {
  execFileSync(
    process.platform === "win32" ? "python" : "python3",
    ["-m", "black", ...(write ? [] : ["--check"]), "--", ...pythonFiles],
    { stdio: "inherit" },
  );
}
console.log(
  `Checked ${checked} source, documentation and configuration files and ${pythonFiles.length} Python files.`,
);
