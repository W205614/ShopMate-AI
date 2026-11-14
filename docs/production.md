# 单店生产部署与恢复

本指南对应 Linux、Docker Compose、单 API、单 SQLite 数据库。生产配置独立于本机演示配置；所有命令从仓库根目录运行。请先读[供应商接入指南](integrations.md)。商户产品、云账号和公网接收端按接入清单完成实网验收。

## 准备配置与目录

宿主机需要 Docker Engine、支持 `--wait` 的 Docker Compose、Node.js 24、Bash、OpenSSL 和 curl。准备域名及 DNS，公网开放 80/443；API、Nginx 和监控服务不发布宿主机端口。Caddy 负责 HTTPS 签发、续期和 HTTP 跳转，详见[官方说明](https://caddyserver.com/docs/automatic-https)。

```sh
cp -n .env.production.example .env.production
chmod 600 .env.production
sudo install -d -m 0700 -o 1000 -g 1000 /etc/shopmate-ai/secrets
sudo install -d -m 0700 -o 1000 -g 1000 /srv/shopmate-ai/runtime/maintenance /srv/shopmate-ai/runtime/releases /srv/shopmate-ai/backups /srv/shopmate-ai/assets
```

这些示例目录仅用于新生产实例；已有目录先核对用途、属主和权限，不要递归修改现有数据。API 用户 UID/GID 为 `1000:1000`。修改目录时同步修改配置，`PROXY_SUBNET` 必须是宿主机未占用的 IPv4 网段；`PROXY_DYNAMIC_RANGE` 必须位于该网段内，`CADDY_IP` 位于网段内但在动态分配范围外，避免其他容器抢占可信代理地址。

用下面命令创建两份新密钥，不覆盖已有文件、不将内容输出到终端：

```sh
sudo -u '#1000' node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {writeFileSync} from "node:fs"; writeFileSync("/etc/shopmate-ai/secrets/encryption-key",randomBytes(32).toString("base64"),{mode:0o600,flag:"wx"}); writeFileSync("/etc/shopmate-ai/secrets/monitor-token",randomBytes(32).toString("hex"),{mode:0o600,flag:"wx"});'
```

将首次管理员密码保存到 `admin-password` 文件，满足 10–128 位且包含字母和数字；供应商私钥、公钥和 APIv3 密钥按接入指南保存。目录内的文件供 UID 1000 读取，使用 `0600` 权限。`ENCRYPTION_KEY_FILE` 是持久化 MFA 和通知数据的加密密钥，恢复旧数据库必须使用原密钥；不支持直接替换密钥后继续读取原加密数据。密钥与数据库备份分开保管。首次管理员密码文件后续不会覆盖数据库中的密码。

编辑 `.env.production`，至少填写：

| 配置                                                 | 作用                                                    |
| ---------------------------------------------------- | ------------------------------------------------------- |
| `PUBLIC_URL`、`DOMAIN`、`ACME_EMAIL`                 | HTTPS 源、域名与证书联系地址；`PUBLIC_URL` 不带末尾 `/` |
| `COMPOSE_PROJECT_NAME`                               | 独立生产项目名，避免与本机及验收项目重名                |
| `API_IMAGE`、`WEB_IMAGE`、`VCS_REF`                  | 同一已验证完整提交对应的镜像及 SHA                      |
| `SECRETS_PATH`                                       | 宿主机密钥目录，容器内固定挂载为 `/run/secrets`         |
| `PRODUCTION_STATE_PATH`、`BACKUP_PATH`、`ASSET_PATH` | 维护记录、备份、图片的独立宿主机目录                    |
| `PAYMENT_CHANNELS`                                   | 已开通的支付产品，至少一个                              |
| `SMTP_*` 或 `SMS_ENABLED` 与 `ALIYUN_*`              | 至少一种联系方式验证渠道                                |

`.env.production` 包含 SMTP、短信及存储凭据，始终保持私有。它和实际密钥均不提交 Git。生产模式拒绝演示重置、旧命令兼容及非 Secure Cookie；未配置的支付或验证渠道不能由页面绕过。AI 可继续关闭，规则与人工客服仍可使用。

## 首次发布与升级

使用经过 CI 验证的镜像。现有 CI 导出 `validated-container-images`，可下载后通过 `docker load` 导入并标记成对应提交标签，或发布到自己的镜像仓库；不要将另一次本地构建当成相同镜像。预检核对 API/Web 镜像的 `org.opencontainers.image.revision` 与 `VCS_REF` 一致。

```sh
node scripts/production-preflight.mjs .env.production
bash scripts/production-release.sh .env.production
```

镜像未下载时预检会失败；发布脚本先校验文件配置，缺少指定镜像时拉取，再检查提交标签。已通过 `docker load` 导入的提交镜像直接复用。脚本写入维护标记，探测共享数据卷中的数据库；旧 API 已停止或容器已移除但数据库仍在时，也先执行升级前一致备份及校验，再向旧 API 发送 SIGTERM 排空，启动新镜像并等待健康。备份使用待发布镜像的一次性 CLI 容器读取共享数据卷，兼容旧镜像尚未包含图片备份命令的情况；该命令不启动 API，也不迁移源库。API 启动负责增量迁移；失败不自动切回旧程序、不清除维护标记，也不删除数据卷。

正常发布和 `--resume` 都在解除维护前执行运行核验：API/Web 各一个运行且健康的容器，实际镜像 ID 与配置镜像一致，提交标签等于 `VCS_REF`，API 处于生产模式。`--resume` 要求现有维护标记属于目标提交，并重新核验目标服务后解除维护。最后公网健康必须返回 `status=ok` 的 JSON；失败会恢复维护标记。只读人工核验可用 `node scripts/production-preflight.mjs .env.production --runtime`。`--skip-files`、`--skip-docker` 输出中会标出跳过项，不能作为发布验收；`--runtime` 不允许跳过 Docker 检查。

此编排始终显式指定 `deploy/compose.production.yaml`，不加载本机 `compose.override.yaml`，也不修改本机 `.env`。当前 Windows 本机关闭自动备份的设置继续保留。

首次部署后：

1. 打开管理登录页，校验密码并设置 TOTP MFA，离线保存恢复码。
2. 在“生产接入 → 商家与协议”填写经营主体、客服、退货地址及已审核的协议正文和版本；未发布完整协议时生产注册会拒绝。
3. 上架真实商品及库存，逐个核对发货、配送、售后规则。生产新库不使用演示商品初始化。
4. 按[接入指南](integrations.md)进行真实渠道联调，并单独记录交易、退款和通知的渠道结果。

## 监控与告警

`/api/internal/diagnostics` 和 `/api/internal/metrics` 使用独立 Bearer 监控令牌；没有写权限，不能用于员工登录。两层公网代理均屏蔽内部路径。公网健康检查仍使用 `/api/health`，不会暴露令牌或业务信息。

宿主机监控使用 `MONITOR_DIAGNOSTICS_DOCKER=true`，通过受限的固定 Docker exec 命令从 API 容器内读取内部诊断；不开放 API 端口。监控进程需要 Docker CLI 访问权，该宿主机权限不等于应用监控令牌的只读权限。配置示例：

```dotenv
MONITOR_BASE_URL=https://shop.example.com
MONITOR_COMPOSE_PROJECT=shopmate-production
MONITOR_DIAGNOSTICS_DOCKER=true
MONITOR_DISK_PATHS=/srv/shopmate-ai/backups,/srv/shopmate-ai/assets
MONITOR_MAINTENANCE_FILE=/srv/shopmate-ai/runtime/maintenance-monitor.json
MONITOR_WEBHOOK_URL=填写自己的HTTPS告警接收地址
```

还应加入 Docker 业务卷所在宿主机磁盘的实际路径。先在宿主机 `backend/` 执行 `npm ci --omit=dev` 安装监控依赖。复制 `deploy/systemd/shopmate-monitor.service` 后按实际部署调整用户、Node 路径和工作目录，私有环境文件保存到 `/etc/shopmate-ai/monitor.env`，再交给 systemd 托管。先用 `--once` 核对诊断、磁盘和备份状态，再制造受控故障并确认告警、恢复消息实际送达。没有填写接收地址只会本地报告。

可选的 `observability` profile 默认不启动。启用前创建 UID 1000 可写的 `runtime/prometheus`、`runtime/alertmanager` 目录：

```sh
sudo install -d -m 0700 -o 1000 -g 1000 /srv/shopmate-ai/runtime/prometheus /srv/shopmate-ai/runtime/alertmanager
docker compose --env-file .env.production -f deploy/compose.production.yaml build edge
docker compose --env-file .env.production -f deploy/compose.production.yaml --profile observability up -d --no-build --wait
```

默认 Alertmanager 接收器名为 `unconfigured`，只接收内部规则，不投递外部消息。将配置复制到私有文件，配置实际接收器并设置 `ALERTMANAGER_CONFIG_PATH` 后才能验收投递。Prometheus/Alertmanager 均无公网端口，可通过内部网络或 SSH 隧道按需检查。

## 备份与失败恢复

生产编排单独启用每日备份，保留规则沿用[可靠性说明](reliability.md)。本地图片由独立目录保存，必须连同对应快照的图片清单和文件一起恢复；只有 SQLite 文件不是图片恢复集。远端上传、下载、完整性校验和图片恢复命令见[存储接入](integrations.md#图片存储与远端备份)。

发布失败时，维护标记位于 `PRODUCTION_STATE_PATH/maintenance/active`，发布记录在 `releases/`。先保留失败日志，检查所用提交和迁移结果。当前业务版本为 5、存储版本为 1；4→5 不重放历史库存和金额，但版本 4 二进制不能直接读取版本 5 库。回到版本 4 必须停机、保留当前恢复资产，核对渠道未结账及快照之后的真实资金变化，再使用已验证的升级前版本 4 恢复集和匹配镜像；不能只换镜像或将数据库回退视为资金回退。恢复操作的路径与停机约束见[可靠性说明](reliability.md#备份检查与离线恢复)。

确认目标镜像与数据修复后，可使用原发布配置执行 `bash scripts/production-release.sh .env.production --resume`：核对维护提交、实际运行镜像和健康，保留维护结束记录，再核对公网健康。该操作不启动目标镜像、不自动恢复数据库或重新执行迁移；旧镜像仍在运行时应先完成正确部署，不能用恢复参数绕过运行核验。

单机仍存在宿主机故障停服边界。容量和恢复耗时见对应提交、资源及数据规模下的验收记录。

## 上线核对

1. 记录待发布的完整提交、对应 CI run 和实际镜像 ID；区分演示体验、生产部署和历史验收，部署使用该次 CI 验证的不可变镜像。
2. 核对域名、代理网段、密钥权限、商户身份、付款产品与至少一种账号验证渠道；启用短信时验证与交易通知模板都必须配置。供应商控制台权限和回调域名按[接入指南](integrations.md)实测。
3. 更新商家主体、客服、退货地址及协议版本；用真实商品库存配置经营规则。历史演示订单和财务记录保持模式边界。
4. 验证升级前数据库、图片恢复集和原加密密钥可用，明确数据版本和恢复目标；将外部支付未结账、未知退款列入发布交接。
5. 通过发布脚本执行维护、备份、排空、启动和运行核验；核对公网健康、登录/MFA、订单读取及当前接入状态。首轮真实渠道联调单独记录扣款、通知、退款、物流和收件结果。
6. 检查内部监控只读访问、任务积压、备份和告警接收；真实远端副本及跨主机恢复必须另行演练。将完成项、失败、回退前提和最终运行或停止状态写入发布记录。

本轮交付变更和发布核验入口见[2026-11-06 发布记录](releases/release-20261106.md)。历史结果见[文档验收导航](README.md#验收报告与证据)，漏洞报告流程见[SECURITY](../SECURITY.md)。

## 开发验证入口

HTTPS 入口使用[依赖更新版 Caddy 构建与原始扫描](security/production-edge-security.md)，先构建本地 edge 镜像，再运行上述命令或维护发布脚本。该修复属于当前源码，已发布的 v0.1.4 不含此入口；API/Web 的已验证镜像可继续使用原版本。API、Web、edge 均对所有严重级别执行原始扫描门禁，不使用 VEX 或忽略规则获得通过。

账号、支付、回调、存储等确定性 HTTP／协议验证进入现有后端测试；`deploy/compose.external-acceptance.yaml` 用独立的 18125/18126/18127 端口提供 Mailpit SMTP、邮件 API 和 Adobe S3Mock。后端设置 `MAILPIT_SMTP_PORT=18125`、`MAILPIT_API_URL=http://127.0.0.1:18126`、`S3MOCK_ENDPOINT=http://127.0.0.1:18127` 后运行本地服务测试。未提供这些变量时相关用例会跳过；完成适配器验收需启动上述服务并补跑。

生产浏览器验证先构建 `frontend/dist`，再在 `frontend/` 执行 `npx playwright test --config playwright.production.config.ts`。专用配置启动仅监听回环的 HTTPS 内存数据库夹具，使用合成身份、密钥和边界服务，不读取实际 `.env`；仅此测试配置允许自签名证书。普通浏览器套件不运行这些生产夹具用例。

容量回归沿用[稳定性专项的隔离与造数流程](acceptance/stability-hardening.md#复跑)。新增 `STABILITY_PROFILE=production-baseline` 仅选择一档 20 并发、600 秒、无额外思考时间；未设置时保留原完整阶段，不能同时开启 `STABILITY_SMOKE`。仍需独立 `shopmate-reliability-*` 项目、1809x 端口、万笔历史订单和 50 个合成工作账号，并核对日志、资源、备份窗口及只读守恒结果。该负载使用模拟交易与隔离故障模型，结果按此请求组成和部署环境记录。
