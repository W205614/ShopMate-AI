# 开发与运维

首次 Docker 部署见 [README](../README.md)。本页用于开发、排查和维护，命令以 PowerShell 为例。

## 配置与访问

根目录 `.env` 从 `.env.example` 复制，已有配置应保留。`ADMIN_PASSWORD` 必须设置，不能上传凭据。首次启动初始化管理员，后续重启不会覆盖已有账号或密码。

| 配置 | 用途 |
| --- | --- |
| `APP_PORT` | Docker 对外端口，默认 18086 |
| `ADMIN_USERNAME`、`ADMIN_PASSWORD` | 首次管理员初始化及密码维护命令使用 |
| `APP_ORIGINS` | 允许写入请求的访问源，多个地址用逗号分隔；更换端口时同步修改 |
| `COOKIE_SECURE` | HTTPS 部署时设为 `true`，同时配置实际访问源 |

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

## 验证命令

按改动范围选择必要检查，已通过且代码未变时不重复扩大测试。以下为各类检查入口，不要求每次全部执行：

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

浏览器测试自动启动隔离后端与 Vite，种子和测试账号仅写入 `backend/.e2e/`，运行前释放 3001/5173 端口。Windows 默认使用已安装的 Edge；Linux 需在 `frontend` 目录先执行 `npx playwright install --with-deps chromium`。

外部容器写入验收必须使用独立项目、镜像标签、端口和数据卷，不能指向日常部署。完整命令、环境变量及边界见 [联合验收](joint-acceptance.md)。日常环境只做健康与公开目录等只读检查。

## 数据保存与升级

Compose 项目名为 `shopmate-ai`，SQLite 文件位于 API 容器 `/app/data/shopmate.sqlite`，挂载卷为 `shopmate-ai_api_data`。不要执行 `docker compose down -v`。备份应使用 SQLite 在线备份机制，或停服后备份完整数据；不能只复制运行中的主文件而忽略 WAL。

当前业务状态版本为 v3，启动时自动迁移。升级前保留一致数据库备份和旧镜像；迁移规则及回滚边界见 [业务与迁移说明](traditional-commerce.md)。数据保存在 SQLite 事务化业务 JSON 中，适用于当前单实例项目，尚未实现多实例扩展。

管理端“恢复演示数据”会重置全体用户的业务数据并恢复初始商品，保留账号、密码和会话。这是有影响的业务重置操作，不用于日常排查。

## 源码与详细记录

- `backend/src/`：认证、HTTP 接口、权限及业务事务；`backend/test/`：单元与 HTTP 测试。
- `shared/domain/`：共享类型、API 契约与商品种子。
- `frontend/src/views/`：商城和后台页面；`frontend/src/services/`：HTTP 客户端及状态缓存。
- `frontend/e2e/`：浏览器测试；`deploy/`：Nginx 和隔离部署配置。
- [分类搜索规则](catalogue.md)、[逐功能交付记录](incremental-delivery.md)、[设计记录](design.md)、[界面复审](ui-review.md)。
