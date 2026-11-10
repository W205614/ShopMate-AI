"""Regenerate the local Alipay SDK from its verified upstream archive and source patch."""

import difflib
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile

root = Path(__file__).resolve().parent.parent
materials = root / "third_party/alipay-sdk"
upstream = materials / "alipay-sdk-4.14.0.upstream.tgz"
assert hashlib.sha256(upstream.read_bytes()).hexdigest() == (
    "51c22fbf391202ee256437688affe94134ebf5a2dd65d27ac5a647d1270130df"
)
with tarfile.open(upstream) as archive:
    files = {}
    for member in archive:
        path = PurePosixPath(member.name)
        assert path.parts[0] == "package" and ".." not in path.parts
        assert member.isfile()
        files[member.name] = archive.extractfile(member).read()

original = files["package/src/util.ts"].decode()
source = original.replace(
    "createSign, createVerify, randomUUID",
    "createSign, createVerify, randomUUID, createCipheriv, createDecipheriv",
).replace("import CryptoJS from 'crypto-js';\n", "")
start = source.index("const IV = CryptoJS.")
end = source.index("// 先加密后加签", start)
source = source[:start] + """const IV = Buffer.alloc(16);

function parseKey(aesKey: string) {
  const key = Buffer.from(aesKey, 'base64');
  return { iv: IV, key, algorithm: `aes-${key.byteLength * 8}-cbc` };
}

export function aesEncryptText(plainText: string, aesKey: string) {
  const { iv, key, algorithm } = parseKey(aesKey);
  const cipher = createCipheriv(algorithm, key, iv);
  return Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]).toString('base64');
}

export function aesDecryptText(encryptedText: string, aesKey: string) {
  const { iv, key, algorithm } = parseKey(aesKey);
  const decipher = createDecipheriv(algorithm, key, iv);
  const plain = Buffer.concat([decipher.update(encryptedText, 'base64'), decipher.final()]);
  return new TextDecoder('utf-8', { fatal: true }).decode(plain);
}

""" + source[end:]
files["package/src/util.ts"] = source.encode()
compiler = r"""
const fs = require('node:fs');
const ts = require(process.argv[1]);
const source = fs.readFileSync(0, 'utf8');
const outputs = { compiler: ts.version };
for (const [name, module] of [['esm', ts.ModuleKind.ES2022], ['commonjs', ts.ModuleKind.CommonJS]]) {
  const result = ts.transpileModule(source, {
    fileName: 'util.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module, esModuleInterop: true, inlineSourceMap: true, inlineSources: true },
  });
  if (result.diagnostics.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error('SDK transpilation failed');
  outputs[name] = result.outputText;
}
process.stdout.write(JSON.stringify(outputs));
"""
compiled = json.loads(
    subprocess.run(
        ["node", "-e", compiler, str(root / "backend/node_modules/typescript")],
        input=source,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=True,
    ).stdout
)
for module in ["esm", "commonjs"]:
    files[f"package/dist/{module}/util.js"] = compiled[module].encode()
package = json.loads(files["package/package.json"])
package["version"] = "4.14.0-shopmate.1"
package["private"] = True
del package["dependencies"]["crypto-js"]
del package["devDependencies"]["@types/crypto-js"]
files["package/package.json"] = (json.dumps(package, indent=2) + "\n").encode()
license_text = (materials / "LICENSE").read_bytes()
assert hashlib.sha256(license_text).hexdigest() == (
    "09d4cdb131ba283054e4f5100652c3a8d337895a904dde6868a1d3d34627eb0c"
)
files["package/LICENSE"] = license_text
files["package/SHOPMATE-CHANGES.md"] = (materials / "CHANGES.md").read_bytes()
patch = "".join(
    difflib.unified_diff(
        original.splitlines(keepends=True),
        source.splitlines(keepends=True),
        fromfile="a/src/util.ts",
        tofile="b/src/util.ts",
    )
)
(materials / "native-crypto.patch").write_text(patch, encoding="utf-8", newline="\n")
output = root / "backend/vendor/alipay-sdk-4.14.0-shopmate.1.tgz"
output.parent.mkdir(exist_ok=True)
with output.open("wb") as raw:
    with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed:
        with tarfile.open(
            fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT
        ) as archive:
            for name, data in sorted(files.items()):
                member = tarfile.TarInfo(name)
                member.size = len(data)
                member.mode = 0o644
                archive.addfile(member, io.BytesIO(data))
manifest = {
    "upstream": "alipay-sdk@4.14.0",
    "upstreamUrl": "https://registry.npmjs.org/alipay-sdk/-/alipay-sdk-4.14.0.tgz",
    "upstreamSha256": hashlib.sha256(upstream.read_bytes()).hexdigest(),
    "licenseUrl": "https://github.com/alipay/alipay-sdk-nodejs-all/blob/v4.14.0/LICENSE.txt",
    "licenseSha256": hashlib.sha256(license_text).hexdigest(),
    "compiler": "typescript@" + compiled["compiler"],
    "output": output.relative_to(root).as_posix(),
    "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
    "sourcePatchSha256": hashlib.sha256(patch.encode()).hexdigest(),
    "files": len(files),
}
(materials / "manifest.json").write_text(
    json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n"
)
print(json.dumps(manifest, indent=2))
