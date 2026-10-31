# 开发与运维

首次 Docker 部署见 [README](../README.md)。本页用于开发、排查和维护，命令以 PowerShell 为例。

开始阅读源码前，先看 [项目结构与脚本索引](project-structure.md)；其他资料见 [文档导航](README.md)。

## 配置与访问

根目录 `.env` 从 `.env.example` 复制，已有配置应保留。`ADMIN_PASSWORD` 必须设置，不能上传凭据。首次启动初始化管理员，后续重启不会覆盖已有账号或密码。

标准 Dockerfile 支持构建参数 `ALPINE_MIRROR`，默认使用 Alpine 官方 CDN。本机遇到该 CDN 的 APK 索引 I/O 错误时，可在 `.env` 显式设置 `ALPINE_MIRROR=https://mirrors.aliyun.com/alpine`，再执行正常构建；该站列于 [Alpine 官方镜像列表](https://mirrors.alpinelinux.org/)。参数只替换源地址前缀，保留基础镜像对应发行版路径、包签名校验及安全更新，不自动切源或无限重试。CI 未配置该参数时仍使用默认 CDN。

| 配置 | 用途 |
| --- | --- |
| `APP_PORT` | Docker 对外端口，默认 18086 |
| `ADMIN_USERNAME`、`ADMIN_PASSWORD` | 首次管理员初始化及密码维护命令使用 |
| `APP_ORIGINS` | 允许写入请求的访问源，多个地址用逗号分隔；更换端口时同步修改 |
| `COOKIE_SECURE` | HTTPS 部署时设为 `true`，同时配置实际访问源 |
| `BACKUP_PATH` | 主机备份目录，默认 `./backups`，独立于业务卷 |
| `LOG_REQUESTS` | 默认记录脱敏请求 ID、路径、状态和耗时，容器日志轮转 |

Docker 默认只监听 `127.0.0.1`，后端没有主机映射端口。修改 `APP_ORIGINS` 不会自动开放外部监听，公开部署还需配置入口、HTTPS 和访问控制。`localhost` 与 `127.0.0.1` 的 Cookie 独立，体验双端时统一使用一种地址。

```powershell
docker compose ps
docker compose logs --tail 100 api web
docker compose stop
docker compose up -d --wait
```

静态服务健康检查为 `/healthz`，API 与数据库健康检查为 `/api/health`。

### 切换端口

例如 18086 已被占用时，在根目录 `.env` 中同时修改以下两项，保留原管理员配置：

```dotenv
APP_PORT=18090
APP_ORIGINS=http://localhost:18090,http://127.0.0.1:18090
```

执行 `docker compose up -d --wait` 应用配置，随后统一通过 `http://localhost:18090` 访问商城与管理端。端口使用其他值时，两个访问源也要同步替换；只改对外端口可能导致页面能打开但写入请求被来源校验拒绝。

## 账号维护

用户在商城注册，可在个人中心修改昵称和密码；改密需要验证原密码，并撤销该用户的全部会话。管理员不开放公开注册，用户和管理员使用独立 Cookie。

更换管理员密码：编辑根目录 `.env` 中的 `ADMIN_PASSWORD`，然后执行以下命令。只改配置或重建容器不会更新已有密码；命令成功后撤销该管理员全部旧会话。

```powershell
docker compose run --rm --no-deps api npm run admin:password
```

认证与权限细节见 [认证说明](authentication.md)。

## 本地开发

使用 Node.js 24，依赖版本以前后端 `package-lock.json` 为准。配置根目录 `.env`，在 `APP_ORIGINS` 中加入实际 Vite 访问源，例如 `http://127.0.0.1:5173`。分别在仓库根目录的两个终端运行：

```powershell
npm --prefix backend ci
npm --prefix backend run dev
```

```powershell
npm --prefix frontend ci
npm --prefix frontend run dev -- --host 127.0.0.1
```

后端默认监听 `127.0.0.1:3001`，Vite 使用 5173 并代理 `/api/`。后端启动脚本读取根目录 `.env`；本地数据在 `backend/data/shopmate.sqlite`，与 Docker 数据卷独立。

本地处理 PDF 还需要 Poppler 的 `pdfinfo`、`pdftotext`、`pdftoppm` 位于启动后端进程的 `PATH` 中；安装后重新打开终端，用以下命令检查。Debian／Ubuntu 可安装 `poppler-utils`，macOS 可通过 Homebrew 安装 `poppler`，Windows 使用适用于本机的 Poppler 二进制包并将其工具目录加入 `PATH`。Docker API 镜像已安装 `poppler-utils`，无需在宿主机额外安装。

```powershell
pdfinfo -v
pdftotext -v
pdftoppm -v
```

PDF 文字提取在本地执行，扫描页和图片识别仍需模型 API，文档索引需 Embedding；配置及边界见 [AI 客服与知识库](ai-support.md)。

## 验证命令

按改动范围选择必要检查，已通过且代码未变时不重复扩大测试。以下为各类检查入口，不要求每次全部执行：

仅修改文档或移动文件时，在仓库根目录运行 `node scripts/check-docs.mjs` 检查本地链接；该检查也会在 CI 中执行。

```powershell
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run test:e2e
```

生产依赖审计使用 `npm --prefix backend audit --omit=dev` 和 `npm --prefix frontend audit --omit=dev`。

容器系统包和 Node.js 内置组件不属于项目 npm 锁文件的审计范围。更新 Dockerfile 中的官方基础镜像摘要后，应重新构建并扫描实际镜像；运行时安全公告还需核对对应 Node.js 补丁版本，不能只比较其内置库显示的版本号，因为安全修复可能回移植而不改库版本号。

```powershell
docker compose build --pull
docker scout cves local://shopmate-ai-api:local
docker scout cves local://shopmate-ai-web:local
```

CI 使用 Trivy 扫描 API/Web 镜像中的系统包和应用库，所有等级报告保存在 `container-vulnerability-reports` 构件中；高危和严重漏洞会使检查失败，包括尚无修复版本的条目。不得以 npm 审计通过代替镜像检查，也不得将未修复告警默认为已修复。

全部验证通过后，CI 导出 `validated-container-images` 构件（保留 1 天）。需要使用已验证的相同镜像时，可下载并解压其中的 `validated-images.tar.gz`，使用 `docker load` 导入，再将 `shopmate-ai-api:acceptance`、`shopmate-ai-web:acceptance` 标记为各自的 `:local` 标签，核对镜像的 `org.opencontainers.image.revision` 与通过 CI 的提交一致后，执行 `docker compose up -d --no-build --force-recreate --wait`。已有业务数据卷保持不变。

浏览器测试自动启动隔离后端与 Vite，种子和测试账号仅写入 `backend/.e2e/`，运行前释放 3001/5173 端口。Windows 默认使用已安装的 Edge；Linux 需在 `frontend` 目录先执行 `npx playwright install --with-deps chromium`。

外部容器写入验收必须使用独立项目、镜像标签、端口和数据卷，不能指向日常部署。完整命令、环境变量及边界见 [联合验收](archive/joint-acceptance.md)。日常环境只做健康与公开目录等只读检查。

## 数据保存与升级

Compose 项目名为 `shopmate-ai`，SQLite 文件位于 API 容器 `/app/data/shopmate.sqlite`，挂载卷为 `shopmate-ai_api_data`。不要执行 `docker compose down -v`。备份应使用 SQLite 在线备份机制，或停服后备份完整数据；不能只复制运行中的主文件而忽略 WAL。

当前业务状态版本为 v4，启动时自动迁移。升级前保留一致数据库备份和旧镜像；维护停机、备份及恢复命令见 [可靠性与运维](reliability.md)。业务存储已拆为分领域记录表及 SKU／订单行关系表，历史快照保留 JSON 字段，旧 `state` 只读保留为迁移证据。当前仍为单实例，尚未实现多实例扩展。

网页“恢复演示数据”默认关闭，不用于日常排查。需要恢复数据时执行停写、备份、离线恢复与核验流程，不能删除数据卷重来。

## 源码与详细记录

目录职责、源码入口和脚本用途统一维护在 [项目结构](project-structure.md)；当前业务、验收证据与历史交付记录统一从 [文档导航](README.md) 查找。
