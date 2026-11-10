# ShopMate-AI local Alipay SDK derivative

Based on alipay-sdk 4.14.0, under its original MIT license. The original npm archive and the upstream license from tag v4.14.0 are retained with SHA-256 identities in this directory's manifest.

The two AES text helpers use Node.js crypto instead of the discontinued crypto-js dependency. AES-CBC, PKCS#7 padding, the protocol's zero IV, Base64 keys and ciphertext, and UTF-8 text remain unchanged. The SDK's signing, verification, HTTP, certificates and public declarations remain upstream code. Malformed decrypted UTF-8 fails explicitly.

The local package is identified as 4.14.0-shopmate.1 and is not published to npm. The upstream npm archive omits its license file, so the original full MIT notice is added to the local package. All other upstream files are retained.

After installing the repository's backend development dependencies, regenerate the source patch and both CommonJS/ESM utility files and archive with `python scripts/vendor-alipay-sdk.py`. The script uses the locked TypeScript compiler, verifies the upstream archive and license, and produces a stable local tarball. Normal Docker/source installation consumes that committed tarball without rebuilding the SDK.
