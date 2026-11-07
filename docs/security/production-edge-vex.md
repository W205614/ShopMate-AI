# HTTPS 入口漏洞的配置评估与 VEX 门禁

评估日期：2026-11-06，2026-11-07 补充 HTML 解析路径。适用范围为本仓库指定的 ShopMate 生产入口配置。下面先保留源码路径评估，再说明 CI 如何在配置 guard 通过后消费临时 OpenVEX；原始完整扫描始终单独保留。

## Conclusion

The reviewed configuration provides evidence for a profile-scoped OpenVEX `not_affected` statement with `vulnerable_code_not_in_execute_path`. The vulnerable library is present and unpatched; the raw finding is retained alongside this configuration assessment.

The statement binds the deployed application profile to its exact image digest and configuration. Changes to the image, modules, configuration or start command require review; another profile can enable the vulnerable ACME server.

## Observed artifact and effective configuration

- Image: `caddy:2.11.9-alpine@sha256:71d41fe4b1ae92a058abc87afe614178b996d8a6b96d0f4c71ae30606e5927e3`.
- `deploy/Caddyfile` SHA256: `bddf46e9a0552c4575da8c41e1b8c63535c960cec7151b193ee4668127a29e91`.
- Adaptation used the actual fixed image, read-only config, disabled networking, synthetic `DOMAIN=shopmate.example` and `ACME_EMAIL=ops@example.com`. No certificate issuance or live service was started.
- `adapted.json` contains only `http` and `tls` apps; HTTP handlers: `encode`, `headers`, `reverse_proxy`, `static_response`, `subroute`. `admin.disabled` is true. No `pki` app, `acme_server` handler, internal issuer or custom certificate getter is configured.
- Image command is `caddy run --config /etc/caddy/Caddyfile --adapter caddyfile`. It does not use `--resume`; persisted autosave configuration is not selected by this command.
- Full observed hashes and command are in `evidence.json`. DOMAIN and ACME_EMAIL remain deployment inputs; public-DNS production validation and effective-config verification are required when using real values.

## Vulnerable path

[Official GHSA](https://github.com/go-jose/go-jose/security/advisories/GHSA-mgcc-cww5-fp2q) identifies excessive CPU in validating attacker-controlled RSA private JWK parameters. v3 through 3.0.5 is affected without a published v3 patch; v4 is fixed in 4.1.6.

1. [Caddy v2.11.9 go.mod](https://github.com/caddyserver/caddy/blob/v2.11.9/go.mod#L24) selects smallstep/certificates v0.30.2, go.step.sm/crypto v0.91.0, go-jose/v3 v3.0.5 and go-jose/v4 v4.1.6.
2. [standard/imports.go](https://github.com/caddyserver/caddy/blob/v2.11.9/modules/standard/imports.go#L8) compiles in PKI and ACME server modules. Compilation/registration does not provision the server. [RegisterModule](https://github.com/caddyserver/caddy/blob/v2.11.9/modules.go#L138) records module information; [app provisioning](https://github.com/caddyserver/caddy/blob/v2.11.9/caddy.go#L573) loads configured apps.
3. [ACME server Handler.Provision](https://github.com/caddyserver/caddy/blob/v2.11.9/modules/caddypki/acmeserver/acmeserver.go#L126) constructs the smallstep authority and mounts `api.Route` at lines 213–218; its [ServeHTTP](https://github.com/caddyserver/caddy/blob/v2.11.9/modules/caddypki/acmeserver/acmeserver.go#L237) dispatches ACME requests. This handler is absent in the observed config.
4. [smallstep ACME routing](https://github.com/smallstep/certificates/blob/v0.30.2/acme/api/handler.go#L145) wraps POST endpoints in `parseJWS`; [middleware.go:104](https://github.com/smallstep/certificates/blob/v0.30.2/acme/api/middleware.go#L104) passes the request body to `jose.ParseJWS` before signature validation.
5. [crypto jose wrapper](https://github.com/smallstep/crypto/blob/v0.91.0/jose/types.go#L283) calls v3 `jose.ParseSigned`.
6. [v3 shared.go:386](https://github.com/go-jose/go-jose/blob/v3.0.5/shared.go#L386) decodes embedded JWKs. [jwk.go:215](https://github.com/go-jose/go-jose/blob/v3.0.5/jwk.go#L215) dispatches an RSA JWK containing `d` to `rsaPrivateKey`; [jwk.go:612](https://github.com/go-jose/go-jose/blob/v3.0.5/jwk.go#L612) builds and validates the key without the later v4 bounds. [jws.go:215](https://github.com/go-jose/go-jose/blob/v3.0.5/jws.go#L215) rejects embedded private keys only after header sanitization has decoded them. That check is not an effective mitigation for this CPU attack.

## Public ACME client and edge requests

- [Caddy ACMEIssuer.SetConfig/Issue](https://github.com/caddyserver/caddy/blob/v2.11.9/modules/caddytls/acmeissuer.go#L329) delegates to certmagic. [certmagic newBasicACMEClient](https://github.com/caddyserver/certmagic/blob/v0.25.6/acmeclient.go#L252) constructs `mholt/acmez/v3` client, separate from smallstep's ACME server.
- [acmez jwsEncodeJSON](https://github.com/mholt/acmez/blob/v3.1.7/acme/jws.go#L86) and [jwkEncode](https://github.com/mholt/acmez/blob/v3.1.7/acme/jws.go#L122) encode/sign a locally held `crypto.Signer` key; they do not parse remote JWKs with go-jose/v3. [HTTP response handling](https://github.com/mholt/acmez/blob/v3.1.7/acme/http.go#L236) decodes CA JSON into concrete ACME response structures or copies certificate bytes. Searches of production acmez/certmagic Go sources found no go-jose/v3, smallstep jose, ParseSigned or JSONWebKey parser calls.
- [certmagic HTTPChallengeHandler](https://github.com/caddyserver/certmagic/blob/v0.25.6/httphandlers.go#L56) checks challenge host/path and obtains local challenge state; it does not parse a request JWS body. TLS-ALPN challenge handling supplies the locally prepared challenge certificate; regular TLS certificate handling uses X.509/PEM, not the vulnerable JWK parser.
- Ordinary edge requests match the configured response/proxy handlers. A request to an ACME-server-looking path cannot instantiate a missing module; it follows the reverse proxy route.
- [admin.go:407](https://github.com/caddyserver/caddy/blob/v2.11.9/admin.go#L407) returns before creating an admin listener when disabled. The reviewed Compose exposes ports 80/443 only and mounts the Caddyfile read-only. Host/operator ability to change deployment config is outside this public request reachability conclusion.

## Preconditions for any automated VEX consumption

Use [OpenVEX's defined justification](https://github.com/openvex/spec/blob/main/OPENVEX-SPEC.md#status-justifications), with an impact statement documenting this profile. Identify the profile separately from the general image and list the image/library as subcomponents if supported by the consumer.

Before applying the statement, check the exact image digest, expected Caddyfile hash, production domain inputs, default explicit config command, `admin.disabled=true`, and the effective adapted module/issuer allowlist. Preserve the raw scan. Any image override, custom module, ACME server/internal PKI enablement, admin activation, additional config import, changed command or changed hash requires fresh review. VEX generation therefore checks the complete effective profile, including both the image and its enabled modules.

The review consists of source-path analysis and effective-configuration checks. It uses a project-generated VEX statement and did not execute a crafted high-CPU payload.

## 当前实现与复跑

[`production-edge-vex.mjs`](../../scripts/production-edge-vex.mjs) 锁定上述镜像摘要、Caddyfile 原始 SHA256、生产 Compose 原始 SHA256 `927d0b198676c0bf2e5b4c2446773e397e2c38ee3b8f364eac783b8256406b61`，并检查只读配置挂载、受限环境变量、镜像默认启动命令和 Compose 命令覆盖。启动命令必须显式包含 `--config /etc/caddy/Caddyfile`，不能使用 `--resume`。

脚本随后使用实际固定镜像执行无网络、只读的 `caddy adapt`，检查 app、handler、issuer 白名单和 `admin off`，并比对完整有效配置的规范化摘要；仅允许替换已经验证的域名和 ACME 邮箱参数。配置、镜像、命令或 Compose 发生变化就失败，需重新核实代码路径和配置后更新评估。

guard 通过后，在新的临时路径生成适用于该部署配置的 VEX。声明限定为 `CVE-2026-116587` 与 `github.com/go-jose/go-jose/v3@v3.0.5`，以及 `CVE-2026-78661` 与 `golang.org/x/net@v0.60.0`，均绑定固定 OCI 镜像摘要。OCI PURL 无法表达运行配置，因此必须始终由 guard 控制生成及后续消费；生成文件与通过 guard 的部署配置共同使用。

以下命令从仓库根目录执行。先安装 Docker Compose、Node.js 24 和 Trivy 0.76.2；拉取固定 Caddy 镜像。只生成配置评估，不启动商城或申请证书：

```sh
set -eu
image='caddy:2.11.9-alpine@sha256:71d41fe4b1ae92a058abc87afe614178b996d8a6b96d0f4c71ae30606e5927e3'
docker pull "$image"
assessment_dir=$(mktemp -d)
trivy image --scanners vuln --format json --output "$assessment_dir/edge-raw.json" "$image"
node scripts/production-edge-vex.mjs --env-file .env.production.example --output "$assessment_dir/edge.openvex.json"
trivy image --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --vex "$assessment_dir/edge.openvex.json" --format json --output "$assessment_dir/edge-assessed.json" "$image"
```

实际部署复核时，把 `--env-file` 指向自己的独立生产文件。脚本不修改配置，不输出完整 Compose 环境或密钥。输出同时包含 `.evidence.json` 和 `.adapted.json`，应与原始扫描和评估扫描一起保存。

CI 保留 API、Web 原有 HIGH/CRITICAL 门禁及完整原始扫描。仅 edge 的后续门禁安装已验证的 Trivy 0.76.2，运行 guard、生成临时 VEX，再使用官方原生 `trivy image --vex`。没有全局忽略文件、`--ignore-unfixed` 或自写 JSON 过滤逻辑。原始扫描上传为 `container-vulnerability-reports`，配置与评估结果另存为 `edge-configuration-vex-assessment`。该方式依据 [Trivy 官方 local VEX 及子组件匹配文档](https://trivy.dev/docs/latest/supply-chain/vex/file/)。

## 本地验收边界

本次使用 Trivy 0.76.2 和 `UpdatedAt=2026-11-06T06:50:38.697107077Z` 的本地漏洞库。结果只适用于这次工具、数据库和固定镜像：

| 报告                            | HIGH | CRITICAL | MEDIUM | UNKNOWN |
| ------------------------------- | ---: | -------: | -----: | ------: |
| 完整原始扫描                    |    1 |        0 |      2 |       3 |
| guard 通过后应用 VEX 的完整扫描 |    0 |        0 |      2 |       3 |

原始扫描包含 1 个 HIGH、2 个 MEDIUM 和 3 个 UNKNOWN。VEX 按固定配置将该 HIGH 标记为执行路径不可达；依赖本身仍未修补，MEDIUM 和 UNKNOWN 原样保留。

最小回归的 3 个用例通过，包含真实离线适配输出及镜像、配置、命令、挂载、管理接口、PKI、ACME 服务端、内部 issuer 和有效配置变化的拒绝场景。实际使用 Trivy 原生匹配验证：正确镜像与子组件的 HIGH 门禁退出码为 0；将子组件版本改为 v3.0.4，或将 OCI 镜像摘要改为另一摘要，均保留目标 HIGH，门禁退出码为 1。结果由 Trivy 原生 VEX 匹配产生。

公网证书签发待实网联调；上游依赖、镜像或配置更新后重新扫描和复核。

## 2026-11-07：HTML 解析器路径复核

发布候选提交 `ad54275` 的 [CI](https://github.com/W205614/ShopMate-AI/actions/runs/42381732989) 在原生 VEX 门禁中保留了新的 HIGH `CVE-2026-78661` 并失败。门禁保持不变；下面补充该具体漏洞的源码与配置评估。

[Go 官方公告 GO-2026-6860](https://pkg.go.dev/vuln/GO-2026-6860) 将问题限定为 `golang.org/x/net/html` 的 `Parse`、`ParseFragment` 及其带选项变体，修复版本为 v0.62.0。该固定镜像仍使用 v0.60.0。Go `govulncheck v1.1.4 -mode=binary -json` 对真实镜像中提取的 `/usr/bin/caddy` 报告了这些受影响符号；本次不采用“代码不存在”的理由，也未修改二进制或声称上游库已修补。二进制 SHA-256 为 `a563843e11cbce39c557bd429ebb787d56f49d51d9bbb3292cd9b36b37a60cdf`。

另按二进制 SBOM 核对 149 个模块对应的源码，扫描 8,088 个非测试 Go 文件，没有缺失模块；除 x/net 自身外，HTML 包导入位于 Smallstep `usage/report.go`。这项源码检查与二进制符号结果分开保存，不将二进制符号存在等同于当前网络路径可达。

调用路径与边界：

1. [Smallstep `usage/report.go`](https://github.com/smallstep/cli-utils/blob/v0.12.2/usage/report.go#L49) 的 `Report.Process` 调用 `html.Parse`，处理帮助报告的 HTML；`processNode` 另调用 `html.Render`。它是明确识别到的解析调用方。
2. [`usage/html.go`](https://github.com/smallstep/cli-utils/blob/v0.12.2/usage/html.go#L99) 的报告创建与处理位于 `htmlHelpAction` / `htmlHelpCommand`，需设置 `report`。[`usage/help.go`](https://github.com/smallstep/cli-utils/blob/v0.12.2/usage/help.go#L21) 通过独立的 Smallstep 帮助命令及 `html` / `report` 参数选择该路径；普通导入或帮助命令注册本身不处理 HTML。
3. 被 guard 固定的进程是 `caddy run --config ... --adapter caddyfile`，不是 Smallstep 的帮助导出。有效配置仅包含上文的 HTTP/TLS app、固定响应、头部、压缩和代理 handler；没有单独的 Smallstep 帮助监听器，也未启用 PKI、ACME 服务端、模板或额外处理器。
4. [Caddy `reverseproxy`](https://github.com/caddyserver/caddy/blob/v2.11.9/modules/caddyhttp/reverseproxy/reverseproxy.go) 转发请求与响应字节，不调用 HTML AST 解析器；其 `x/net` 使用为 `http/httpguts` / `http2`。公网 ACME 客户端的 JSON、证书及本地挑战处理路径沿用上文核对结果。请求正文或上游 HTML 响应不能选择 Smallstep CLI 帮助导出动作。

据此对当前固定运行配置增加第二条 `not_affected` / `vulnerable_code_not_in_execute_path` 声明。它是项目对具体运行路径的评估，既不扩展至其他 Caddy 配置，也不替代 v0.62.0 的实际补丁。新增或改变模块、命令、环境与有效配置仍由原 guard 拒绝；未使用全局忽略或自写漏洞过滤器。

使用 Trivy 0.76.2 的本地原生扫描复核：完整原始报告为 **2 HIGH、4 MEDIUM、1 UNKNOWN**；同一镜像经 guard 生成的 VEX 处理后，HIGH/CRITICAL 为 0，4 MEDIUM 与 1 UNKNOWN 原样保留。将 x/net 子组件改成 v0.59.0 后，`CVE-2026-78661` 保留且门禁退出 1；将 OCI 摘要改错后，两条 HIGH 均保留且退出 1。正确声明退出 0。证据见[复核摘要](../qa/security-edge-20261107/summary.json)。没有向真实服务发送高 CPU 攻击负载；公网证书签发及实际部署验证仍按生产指南执行。
