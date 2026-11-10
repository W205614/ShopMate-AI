import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import reference from "./fixtures/alipay-aes-vectors.json";

interface AesHelpers {
  aesEncryptText(text: string, key: string): string;
  aesDecryptText(text: string, key: string): string;
}
const require = createRequire(import.meta.url);
const sdkRoot = dirname(require.resolve("alipay-sdk/package.json"));
const variants: [string, AesHelpers][] = [
  ["ESM", await import(pathToFileURL(join(sdkRoot, "dist/esm/util.js")).href)],
  ["CommonJS", require(join(sdkRoot, "dist/commonjs/util.js"))],
];

describe.each(variants)("Alipay native AES (%s)", (_name, sdk) => {
  it("interoperates with the unmodified upstream SDK reference vectors", () => {
    for (const { key, text, ciphertext } of reference.vectors) {
      expect(sdk.aesEncryptText(text, key)).toBe(ciphertext);
      expect(sdk.aesDecryptText(ciphertext, key)).toBe(text);
    }
  });
  it("rejects malformed ciphertext instead of returning a successful plaintext", () => {
    expect(() =>
      sdk.aesDecryptText("AA==", reference.vectors[0]!.key),
    ).toThrow();
  });
});

it("ships the upstream MIT notice and removes the discontinued dependency", () => {
  const metadata = JSON.parse(
    readFileSync(join(sdkRoot, "package.json"), "utf8"),
  );
  expect(metadata.version).toBe("4.14.0-shopmate.1");
  expect(metadata.dependencies).not.toHaveProperty("crypto-js");
  expect(readFileSync(join(sdkRoot, "LICENSE"), "utf8")).toBe(
    readFileSync(
      new URL("../../third_party/alipay-sdk/LICENSE", import.meta.url),
      "utf8",
    ),
  );
});
