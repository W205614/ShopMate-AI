import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { check, resolveConfig } from "prettier";

process.chdir(fileURLToPath(new URL("../../", import.meta.url)));

const archivedScript = "docs/qa/stability-20261020/force-backup-due.mjs";
const paths = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--deduplicate",
    "-z",
  ],
  { encoding: "utf8" },
).split("\0");

let checked = 0;
for (const filepath of paths) {
  if (
    filepath === archivedScript ||
    !/\.(?:[cm]?[jt]sx?|vue|css)$/.test(filepath)
  )
    continue;

  let source;
  try {
    source = await readFile(filepath, "utf8");
  } catch (error) {
    // A tracked file deleted from the working tree can still be in the index.
    if (error.code === "ENOENT") continue;
    throw error;
  }

  const options = await resolveConfig(filepath);
  if (
    !(await check(source.replaceAll("\r\n", "\n"), { ...options, filepath }))
  ) {
    console.error(filepath);
    process.exitCode = 1;
  }
  checked++;
}

console.log(`Prettier checked ${checked} source files.`);
