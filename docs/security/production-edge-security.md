# HTTPS 入口依赖修复与验证

核对日期：2026-11-10。固定上游 `caddy:2.11.9-alpine@sha256:71d41fe4b1ae92a058abc87afe614178b996d8a6b96d0f4c71ae30606e5927e3` 的原始扫描包含 2 HIGH、4 MEDIUM、1 UNKNOWN。官方最新正式 [Caddy 2.11.9](https://github.com/caddyserver/caddy/releases/tag/v2.11.9) 仍包含这些旧依赖，不能将“拉取最新版”视作修复。

2026-11-12 补充：下文零发现与 Go 1.27.3 的运行结果属于 2026-11-10 历史验证。新的 CI 扫描发现 Go 标准库 CVE-2026-97054，当前构建输入已更新至固定摘要的 Go 1.27.4；具体边界见文末增补，不将历史零发现结果延用为今天的扫描结论。

## 最小修复输入

使用[官方支持的源码包装入口](https://caddyserver.com/docs/build)，保留 Caddy 2.11.9 及全部标准模块，仅更新安全依赖；入口、锁文件和镜像构建见 [deploy/edge](../../deploy/edge)。未修改 Caddy 的 HTTP/TLS 业务实现，没有用修改版本字符串、移除标准模块或 VEX 获得通过。

| 原始发现                          | 原版本                               | 实际更新目标                                                                         |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| CVE-2026-4738                     | zlib 1.3.2-r1                        | Alpine zlib 1.4-r0                                                                   |
| CVE-2026-116587 / 116585 / 116586 | go-jose/v3 3.0.5，无 v3 修复版       | Smallstep 官方 v4 迁移，使用 go-jose/v4 4.1.9                                        |
| CVE-2026-78661 / 97045            | x/net 0.60.0                         | x/net 0.62.0                                                                         |
| GO-2026-5932                      | x/crypto 0.57.0，含已弃用 OpenPGP 包 | x/crypto 0.58.1-0.20261009181718-2f1f834330b2，验证未重新引入单独的过时 OpenPGP 模块 |

Smallstep crypto 使用正式版 [v0.92.0](https://github.com/smallstep/crypto/releases/tag/v0.92.0)。certificates 使用官方已合入的 [6d5a251fbe010383c93ead1ab451a329986b80ca](https://github.com/smallstep/certificates/commit/6d5a251fbe010383c93ead1ab451a329986b80ca)，锁定为 `v0.30.3-0.20261105213751-6d5a251fbe01`；这是固定的上游提交，尚非正式 certificates 发行版。该配对也已出现在 Caddy 上游开发分支的依赖中，当前构建使用固定版本及 go.sum，不跟踪浮动分支。

Go 官方的 [OpenPGP 公告](https://pkg.go.dev/vuln/GO-2026-5932) 将修复边界放在上述拆包提交之后；稳定版 0.58.0 早于它，单独升到 0.58.0 不足以解决。x/net 的两个修复见 [HTML 解析 DoS](https://pkg.go.dev/vuln/GO-2026-6860)和[命名空间渲染 XSS](https://pkg.go.dev/vuln/GO-2026-6866)。[Alpine 官方配方](https://github.com/alpinelinux/aports/blob/3.24-stable/main/zlib/APKBUILD)标明 zlib 1.4-r0 修复 CVE-2026-4738。

原配置只有代理、编码、头部与固定响应，没有启用 Smallstep ACME 服务端、内部 PKI、HTML 模板或 CLI HTML 帮助导出。Caddy 为静态 Go 程序，不动态链接 zlib；但镜像内 curl/libcurl、apk/libapk 确实依赖 zlib。这些是运行影响分析，不能代替对随镜像携带组件的实际更新，也不作为当前扫描例外。

## 构建与部署入口

修复位于本次维护后的源码；已发布 v0.1.4 Tag 和 API/Web 镜像没有被覆盖。默认日常 demo 编排不运行 Caddy。生产模板使用本地 `shopmate-ai-edge:local`，先在包含此修复的源码根目录构建：

```sh
docker build -f deploy/edge/Dockerfile -t shopmate-ai-edge:local .
```

也可按已初始化的生产配置执行：

已有配置若仍指定旧官方 Caddy 摘要，先保留原配置与恢复资料，将其 `CADDY_IMAGE` 明确设为 `shopmate-ai-edge:local`（或其他新的本地构建标签），再执行下列命令。不能将旧上游摘要作为新构建标签。

```sh
docker compose --env-file .env.production -f deploy/compose.production.yaml build edge
```

需要 Docker BuildKit 及访问 Docker Hub、Go 官方模块代理/SumDB 和 Alpine 签名仓库的网络；无需宿主安装 Go。Go 编译器与上游 Caddy 运行层均固定摘要，zlib 固定为 1.4-r0，Go 依赖由 go.mod/go.sum 固定并校验。第三方 Go 许可、NOTICE 与实际构建信息保存在镜像的 `/usr/share/licenses/shopmate-edge/`、`/usr/share/caddy/build-info.txt`、`/usr/share/caddy/modules.txt`。

API/Web 的 `VCS_REF` 不用于 edge 源码标记。上述手动构建默认将 edge revision 标为 `local`；需要记录确切来源时，显式追加 `--build-arg VCS_REF="$(git rev-parse HEAD)"`。CI 使用目标提交 SHA，不能把已发布 API/Web 的旧提交当作新 edge 的源码。

本次没有新增 Registry 包或生产部署。`CADDY_IMAGE` 可指向使用者自行验证的其他镜像，但版本变化后仍须对实际镜像复扫和运行验收。发布脚本要求镜像已获取或构建；不要让它尝试从 Docker Hub 拉取尚未发布的本地镜像名。完整生产配置、恢复与平台条件见[生产指南](../production.md)。

## 不使用例外的验证

准备 Node.js 24、Trivy 0.76.2；TLS 夹具验证另需 OpenSSL。先生成原始报告，再以所有严重级别执行硬门禁：

```sh
trivy image --scanners vuln --format json --output edge-vulnerabilities.json shopmate-ai-edge:local
trivy image --scanners vuln --exit-code 1 shopmate-ai-edge:local
node scripts/production-edge-check.mjs --env-file .env.production.example --output edge-config-evidence.json
node scripts/test-production-edge.mjs --image shopmate-ai-edge:local --web-image shopmate-ai-web:local --output edge-smoke-result.json
```

输出文件应使用新的路径，避免覆盖原始证据。这里没有 `--vex`、`--ignore-unfixed`、严重级别过滤或自写漏洞过滤器。配置检查只验证明确配置命令、只读挂载、关闭管理接口及预期代理配置，不产生漏洞豁免。TLS 回归使用内部 Docker 网络、合成 Nginx 上游和本地测试证书，客户端正常校验证书；覆盖 HTTPS 代理、转发协议、HSTS、HTTP 跳转、内部路径拦截、gzip、维护阻断及恢复。它不替代公网 ACME 签发或真实生产平台验收。

CI 构建同一 edge 输入，保留完整原始报告，对 API/Web/edge 的所有严重级别统一执行失败门禁。配置及 TLS 结果另存为 `edge-configuration-check`；历史 VEX 记录仅在[历史说明](production-edge-vex.md)中追溯，不参与当前门禁。

## 本次本机结果

2026-11-10，在 Windows Docker Desktop 的 Linux/amd64 环境，对实际构建镜像完成：

| 检查                                     | 结果与边界                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| 同一 Trivy 0.76.2 / 数据库的完整原始扫描 | 上游 7（2 HIGH、4 MEDIUM、1 UNKNOWN）→ 修复镜像 0；`--exit-code 1` 实际退出 0                |
| 实际二进制                               | Go 1.27.3、CGO=0 与原镜像一致；136 个标准模块集合完全相同；无 go-jose/v3 或单独 OpenPGP 模块 |
| 有效生产配置                             | 原 Caddyfile 的离线 validate/adapt 通过，原路由和 issuer 规范化摘要不变                      |
| 隔离 HTTP/TLS                            | 8/8，客户端使用镜像内 curl 正常验证测试证书并协商 HTTP/2；内部网络无宿主端口和公网 ACME 请求 |
| 配置及维护发布协议回归                   | 10/10，后端类型检查通过                                                                      |

本机镜像 Image ID：`sha256:9fd0da2e5aafada398b9814f794294b40d971eb6f54f6c26c0394f72eb6e3a4b`，本地验证标签为 `shopmate-ai-edge:patched`。CI 会从相同锁定输入独立构建，并保留目标提交的原始扫描与运行结果；CI 的实际结果以 [Application validation](https://github.com/W205614/ShopMate-AI/actions/workflows/validation.yml) 为准。本机通过不代表公网证书、真实生产部署或生产容量验收。

首次模块下载连接中断、OpenSSL 缺少系统配置，以及 Docker Desktop 内部网络端口映射限制的夹具失败记录均保留；没有将这些初次失败改述为首次通过。夹具现在使用自身 OpenSSL 配置和容器内校验，不修改主机证书信任或开放额外网络。

## 2026-11-12 Go 标准库安全增补

[CI 43136001580](https://github.com/W205614/ShopMate-AI/actions/runs/43136001580) 的 API/Web 扫描通过，edge 的原始完整报告新增 1 项 UNKNOWN：CVE-2026-97054，实际二进制使用 Go 1.27.3。硬门禁按预期失败，没有过滤该项。

[Go 官方漏洞记录](https://github.com/golang/vulndb/blob/master/data/osv/GO-2026-6859.json)说明，HTTP/1 服务在并发读取请求体、写响应头并超过 MaxBytesReader 限制时可能因竞态崩溃，修复边界为 1.26.11、1.27.4。[Go 发布记录](https://go.dev/doc/devel/release#go1.27.4)确认 1.27.4 已正式发布。这里直接更新编译器并重建标准库，不以特定代理配置是否触发该竞态作为豁免依据。

构建输入改为官方 `golang:1.27.4@sha256:5e8afd493a7124a8586e134d9b532731161d4b9becf9dee5a5956b107426f93d`；Caddy 版本、标准模块、Go 模块锁文件、CGO=0 和运行层保持原有约定。配置、TLS 和全严重级别扫描仍由同一验证工作流执行，实际结果以对应提交为准。

本次仍是源码维护，没有发布 edge Package、覆盖既有 API/Web 镜像或部署生产；默认本机 demo 不使用 Caddy。生产使用者需从修复后的源码重新构建并验收 edge，不能只更新文档而继续使用旧二进制。
