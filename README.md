# ShopMate-AI

ShopMate-AI 是一个中文单店商城。顾客选规格、下单和申请售后，运营人员在后台发货、管理库存并核对收退款。支付、物流和退款均为模拟流程。默认客服提供 FAQ 和人工回复，也可接入 AI，根据商品、本人订单和已发布的知识回答问题。

![商城首页，可按分类浏览商品](docs/screenshots/storefront-desktop-fold.jpg)

## 快速部署

准备 Git、已启动的 Docker 和支持 `--wait` 的 Docker Compose。首次构建需要访问镜像仓库和 npm 源；默认体验无需模型密钥。

### 1. 获取项目

```sh
git clone https://github.com/W205614/ShopMate-AI.git
cd ShopMate-AI
```

在项目根目录复制配置模板。Windows PowerShell：

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Linux 或 macOS：

```sh
[ -f .env ] || cp .env.example .env
```

### 2. 配置管理员

打开 `.env`，填写 `ADMIN_PASSWORD`，使用 10–128 位、至少包含字母和数字的密码。首次启动会创建管理员，用户名默认为 `admin`。已有部署请使用[密码维护命令](docs/development.md#账号维护)修改密码。

### 3. 启动服务

Linux 首次部署先创建备份目录，供容器内的用户（UID/GID 均为 1000）写入。自定义了 `BACKUP_PATH` 时，请将下列路径换成实际目录，并确保父目录已存在。

```sh
if [ ! -e ./backups ]; then
  mkdir -m 0700 -- ./backups
  sudo chown 1000:1000 -- ./backups
fi
ls -ldn -- ./backups
```

已有目录先核对用途和权限，仅按需调整目录本身。Windows Docker Desktop 通常可直接启动。首次备份的可写性和恢复校验见[可靠性与运维](docs/reliability.md#正常运行和观测)。

```sh
docker compose up -d --build --wait
docker compose ps
```

当 `api` 和 `web` 均显示 `healthy`，打开[健康接口](http://localhost:18086/api/health)，应看到 `{"status":"ok"}`。随后即可进入[商城](http://localhost:18086/)或[管理后台](http://localhost:18086/admin/login)。默认仅供本机访问，体验时统一使用 `localhost`。

启动失败时，用 `docker compose logs --tail 100 api web` 查看日志。端口占用、镜像源及公网访问配置见[开发与运维](docs/development.md)。日常停止用 `docker compose stop`，再次启动用 `docker compose up -d --wait`。业务数据在 Docker 卷中，`docker compose down -v` 会删除该卷。

## 第一次体验

新商城已包含商品、分类和 FAQ。用第一笔订单体验顾客和运营人员如何配合：

1. 在商城[注册顾客账号](http://localhost:18086/register)，选择有库存的商品规格，进入结算，填写收货地址并完成模拟支付。记下订单号。
2. 另开标签页，用刚配置的管理员账号登录后台。在“订单管理”找到该订单，填入模拟承运商和单号后发货。
3. 回到商城的订单详情，刷新后核对物流信息，确认收货。

想体验 AI 客服，可按[模型配置说明](docs/ai-support.md#模型配置)在服务端配置密钥并重新启动。顾客登录后可从商品或本人订单发起咨询；加购、取消待付款订单和申请售后都需要顾客确认。

## 从哪里读源码

```text
frontend/    Vue 商城与运营后台、浏览器测试
backend/     Express API、SQLite 事务、后台任务与后端测试
shared/      前后端共用的类型、API 契约和测试辅助代码
deploy/      Nginx 配置和专项验收用的 Compose 覆盖文件
scripts/     仓库检查与宿主机维护脚本
docs/        开发说明、业务规则、验收报告和历史证据
.github/     GitHub Actions 验证流程
```

追踪刚才的下单流程，可从[结算页面](frontend/src/views/shop/CheckoutView.vue)进入[前端 API 调用](frontend/src/services/api.ts)，再看[后端 HTTP 入口](backend/src/app.ts)和[订单事务](backend/src/commerce.ts)。其他模块和脚本见[项目结构与阅读顺序](docs/project-structure.md)。

本地开发与测试见[开发指南](docs/development.md#本地开发)。业务规则、AI 知识库、压测条件、故障记录及发布验证统一从[文档导航](docs/README.md)查阅。
