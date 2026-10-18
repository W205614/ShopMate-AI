# 存储、稳定性与故障处理

本项目的运行边界是单店、单仓、一个 API 进程、一份本地 SQLite 文件。支付、物流和退款仍为业务模拟。文件备份、健康检查和容器重启策略不能证明生产级可用性；容量结论应以交付报告中的环境、数据量、负载和提交 SHA 为准。

## 存储和并发规则

- `accounts`、`sessions` 保留原账号、密码散列、会话及 ID；业务迁移版本为 4，存储结构版本为 1。启动拒绝高于当前程序支持范围的版本。
- 业务按集合落入 `biz_*` 表，每条记录独立存储；状态、所属用户、时间、商品等字段投影为可索引列。商品 SKU、订单行另有关系表、唯一键、库存/金额检查及父记录外键。嵌套业务快照仍保存为记录 JSON，此结构不等于完全第三范式建模。
- 旧 `state` JSON 保留原始字节，迁移后由触发器禁止更新和删除。新写入只更新变化的记录及相应 SKU/订单行，不双写旧状态。迁移在同一事务中完成，失败回滚，重复启动不重复迁移。
- 写事务使用 `BEGIN IMMEDIATE`，一次完成校验、库存/金额变更、业务流水及同事务命令结果。事务回调禁止返回 Promise；网络调用和密码计算不进入写事务。SQLite 配置 WAL、外键检查和 5 秒锁等待。
- 新订单使用 `reserved-v1` 预占规则，报价不预占；账面库存减有效待付款预占为可售量。付款、取消、超时均按服务端最新状态处理。历史订单不补写新库存、积分或售后策略，原期限不延长。
- 前端列表使用 `/api/bootstrap` 和 `/api/collections/:collection` 分领域查询、SQL 筛选分页，普通页最大 100 条；库存工作台按 SKU 分页。兼容 `/api/state` 仍存在并返回弃用标记，其全量读取成本较高，不作为新客户端接口。
- 客服会话默认按等待人工、人工接待、模拟客服、已关闭排序，各状态内按创建时间和 ID 倒序。`locate=<会话 ID>` 在同一筛选条件和权限范围内计算全局页码，返回 `located`；筛选排除目标时不会擅自清除筛选。评价和领券关联的订单上下文遵循订单权限：无订单读取权限的员工只得到订单 ID、所属用户、状态及评价资格所需的条目数量字段，不包含收货地址、电话或财务金额。
- 财务列表的 `totals` 使用同一筛选条件汇总全量匹配流水，返回十进制整数字符串，以 BigInt 累加避免 Number 精度和 SQLite 整数求和溢出。净收支不等于利润。

## 正常运行和观测

Compose 的 `api_data` 保存 `/app/data/shopmate.sqlite`，宿主机 `BACKUP_PATH` 独立挂载到 `/app/backups`。生产环境应为备份目录配置独立介质、访问控制及容量监控；同机备份无法覆盖整机丢失。

Linux 全新部署应在启动前按 [README](../README.md#3-启动服务) 创建备份绑定目录，供 API 运行用户 UID/GID `1000:1000` 写入，新目录权限为 `0700`。否则 Docker 自动创建的 root 属主目录可能导致 `backup_failed`，即使服务健康检查仍通过。自定义 `BACKUP_PATH` 时准备对应的宿主机目录；已有目录先核对用途、属主和权限，仅按需调整该目录本身，不要递归更改备份文件或其他数据。Windows Docker Desktop 通常无需同样的 Linux 属主设置，但仍应确认目录可写，并执行下文的首次手动备份与校验。

启动后可用 API 的实际运行用户检查挂载目录的写入权限；检查成功不代表已经完成备份：

```powershell
docker compose exec api node --input-type=module -e "import fs from 'node:fs'; fs.accessSync('/app/backups', fs.constants.W_OK)"
```

Dockerfile 固定本轮实际使用的 Node 与 Nginx 基础镜像摘要，业务依赖通过 npm 锁文件安装。更新基础镜像摘要或依赖后重新执行检查与部署验收，不把浮动标签自动更新当作已验证升级。

```powershell
docker compose ps
docker compose logs --tail 200 api
docker compose logs --tail 100 web
Invoke-RestMethod http://127.0.0.1:18086/api/live
Invoke-RestMethod http://127.0.0.1:18086/api/health
```

`/api/live` 表示请求能到达进程；`/api/health` 额外执行数据库查询，并在停机排空期间返回 503。Nginx `/healthz` 只检查 Web 进程。Docker 的健康状态只提供信号，`restart: unless-stopped` 不会单独因为 unhealthy 重启仍在运行的进程。

请求响应包含 `X-Request-ID`，请求错误返回可识别错误码。`LOG_REQUESTS=true` 时日志记录方法、路径、状态、耗时和请求 ID，不输出请求正文、Cookie 或密码。Nginx 使用实际连接地址覆盖 `X-Forwarded-For`；Compose API 不对宿主机发布端口，Express 信任一层代理。自行增加代理或公开 API 端口时必须重新检查此信任边界。

含员工密码的幂等指纹使用与密码散列相同的有界 scrypt 队列，并按身份、方法和请求标识派生独立公开盐，保证并发首见请求能够稳定比较；派生在事务外完成。浏览器对这类恢复标识额外使用 PBKDF2-HMAC-SHA256 慢派生，快速 SHA-256 中间值和密码均不写会话存储。其余业务命令保持普通参数摘要路径。

Nginx 使用上游 HTTP/1.1 连接池，避免高请求量下短连接耗尽临时端口；空闲连接 4 秒回收，早于 Node 的 5 秒超时。通过 Docker DNS 定期刷新 API 地址，支持 API 单独重建。Web 容器健康检查会经过代理查询 `/api/health`，`/healthz` 仍只表示静态服务存活。访问日志在 server 层覆盖镜像默认日志，只记 URI 路径、不记查询串。API 内存上限 1 GiB，容器日志每份 10 MB、保留 3 份；这些限制用于避免无限占用，不能替代宿主机磁盘和告警监控。

服务限制同时在途请求及密码哈希等待队列。429 表示被限流或队列已满；503 `DATABASE_BUSY` 表示锁竞争。客户端应保留原业务请求键，稍后查询 `/api/requests/:id?method=...` 再按原键重试。409 版本冲突应刷新并核对差异，不能自动覆盖；确定要重新操作时才使用新的请求键。

锁定失败不再次尝试向同一已锁定数据库写失败审计，避免额外一次锁等待；改为结构化 `database_busy` 日志，含请求、操作者、动作及对象标识。维护时应将该日志与正常数据库审计一并留存。

后台 `job_queue` 持久化通知和每分钟超时/清理任务，每次最多取 20 个任务；通知记录和任务完成标记在同一事务提交。失败按指数间隔重试，最多 5 次，随后保留为 failed。店主可查询 `/api/admin/jobs`。恢复失败任务前先排除原因，维护人员核实后可将该任务重新设为 pending、清零 attempts 并设置 run_after；通知使用固定任务派生 ID，重复投递不会重复生成通知。

## 备份、检查与离线恢复

启用 `BACKUP_DIR` 后，进程每分钟检查一次是否需要当天的备份；首次检查会创建备份，成功后当天不再重复，重启后可以再产生一份。日期键使用 UTC。仅自动清理带有效清单、原因是 daily、名称为 `shopmate-daily-*.sqlite` 的旧文件，保留最新 7 份；手动、升级前和恢复前备份不参与自动清理。

在线备份通过 Node 的 SQLite backup API 创建一致快照，覆盖 WAL 中已提交事务。每份 `.sqlite` 同时生成 `.sqlite.manifest.json`，清单包含 SHA-256、结构/业务版本、修订号、集合数量及业务/账号/会话摘要。检查执行文件校验和、SQLite integrity_check、外键检查及摘要比对。备份清单不包含密码散列或会话原文；备份数据库本身含敏感数据，需要限制访问。

备份、检查和恢复 CLI 在标准错误输出结构化维护记录，包含本机维护操作者标签、请求标识、文件名、时间及开始／完成／失败结果，不向只读原库写审计。执行维护时应一并保存命令输出；独立 `compose run --rm` 的日志不会自动进入常驻 API 容器。管理员密码重置在业务库记录审计并撤销旧会话。

以下命令在仓库根目录运行，先将日期变量赋值为本次唯一文件名：

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
docker compose exec api npm run maintenance -- backup "/app/backups/shopmate-manual-$stamp.sqlite"
docker compose exec api npm run maintenance -- inspect "/app/backups/shopmate-manual-$stamp.sqlite"
```

升级前先停写并保留当前镜像标签、Compose 配置和挂载清单。使用已经构建但尚未启动服务的新镜像执行备份命令；该命令以只读连接打开原库，不触发业务迁移：

```powershell
docker compose stop web api
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
docker compose run --rm --no-deps api npm run maintenance -- backup "/app/backups/shopmate-preupgrade-$stamp.sqlite" --reason=preupgrade
docker compose run --rm --no-deps api npm run maintenance -- inspect "/app/backups/shopmate-preupgrade-$stamp.sqlite"
```

确认备份摘要后再启动候选版本执行迁移，并核对账号、会话、订单金额、库存、流水和容器镜像 SHA。不要通过删除业务卷处理启动失败，也不要执行全局 volume prune。

恢复会覆盖目标文件，必须停止所有访问目标库的进程。恢复命令要求明确设置 `CONFIRM_RESTORE=STOPPED_AND_BACKED_UP`，拒绝备份与目标同路径，拒绝存在 `<数据库路径>.running` 标记的目标，并在替换前保存当前目标的一致备份。服务器异常退出可能遗留运行标记；只有确认旧 API 及维护进程均已停止、挂载路径正确后，才能删除该特定标记。不能把删除标记当作停止服务。

```powershell
docker compose stop web api
# 将下列文件名替换为已校验的具体备份，不使用通配符。
docker compose run --rm --no-deps -e CONFIRM_RESTORE=STOPPED_AND_BACKED_UP api npm run maintenance -- restore /app/backups/shopmate-manual-YYYYMMDD-HHMMSS.sqlite /app/data/shopmate.sqlite
docker compose up -d api web
```

原目标的恢复前备份写到所选备份所在目录，名称为 `shopmate-pre-restore-*.sqlite`。恢复工具先验证备份，再复制校验；将旧主文件和 WAL/SHM 移到同目录暂存位置，替换成功后才清理。最终替换失败则将主文件和侧文件全部恢复原位；成功但旧文件清理受阻时，输出 `retainedOriginalFiles` 供核查。若升级后已有新写入，恢复旧备份会丢失备份之后的交易；应先保留新库证据，决定前向修复或记录可接受的数据恢复点。备份的最大业务版本不能高于运行程序支持范围。

## 常见故障处置

| 现象               | 核查和处置                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 页面失败、502/504  | 保存请求 ID；分别检查 Web `/healthz`、API `/api/live`、`/api/health`、容器日志、退出状态和网络。先确认原操作是否提交，再重试。 |
| 429                | 检查调用量、认证重试及队列；降低频率，保留原请求键。不要自动无限重试。                                                         |
| 503 DATABASE_BUSY  | 排查第二个 API、维护进程或长事务；确认单写进程边界，不要直接提高超时掩盖阻塞。                                                 |
| 磁盘不足、备份失败 | 检查业务卷和备份目录的空间及权限；保护业务库，先处理有明确保留策略的历史备份或日志。备份失败不会标记当天成功，下次检查会重试。 |
| 迁移失败           | 保存启动日志、旧库备份和版本；迁移事务回滚。使用匹配版本的镜像排查，不手工删除表或降低版本号。                                 |
| API 异常退出       | 查看 exit code、OOM、日志及磁盘；重启后未完成任务可补跑。先确认数据库可打开及 integrity_check，再决定是否恢复。                |
| 订单或金额差异     | 使用财务核对页定位订单、退款、采购与流水关联；保留审计。禁止通过直接改金额、重放扣库或补造历史收款来消除差异。                 |

## 验证边界

自动化测试包括旧 JSON 迁移及重复启动、账号会话保留、历史期限保持、只写变化行、局部订单事务保留其他订单、SKU/订单行约束、SQL 列表及权限隔离、在线备份和离线恢复、通知重复投递及有限重试。复跑命令：

```powershell
npm --prefix backend test -- test/migration.test.ts test/storage.test.ts test/maintenance.test.ts test/read-routes.test.ts
```

这些测试验证确定性的行为和恢复路径，不代替持续压测、真实磁盘故障、长时间运行或真实支付网关验收。浏览器、50 并发、1 万订单、故障演练和最终部署证据以相应交付报告为准。

对已取得的独立数据库快照可运行迁移演练；输出目录必须是新目录，命令不会连接日常业务卷：

```powershell
cd backend
node --import tsx scripts/migration-rehearsal.ts ../.delivery/release-YYYYMMDD/before.sqlite ../.delivery/release-YYYYMMDD/migration-rehearsal
```

脚本生成升级前一致备份、迁移副本、升级后备份、恢复副本及 `report.json`。报告只输出数量和摘要，比较已有业务字段、账号会话、旧 JSON 字节、历史订单策略、重复打开及恢复结果，并核对输入快照主文件 SHA-256 未改变。该演练不表示已经升级日常容器。

### 独立容量与故障复跑

以下示例只针对新建验收项目；每个数据集使用新的项目名及数据卷。`seed-load.ts` 只允许验收环境，遇到已有 loaduser 会拒绝重复造数。端口 18086 禁止用于负载脚本。

```powershell
$env:ADMIN_PASSWORD = 'AcceptanceOnly123!'
$env:APP_PORT = '18088'
$env:APP_ORIGINS = 'http://127.0.0.1:18088'
$env:ACCEPTANCE_TAG = 'capacity-check'
$env:ACCEPTANCE_LEGACY_COMMANDS = 'false'
$env:VCS_REF = git rev-parse HEAD
# 用本次独立的新项目名替换该值。万笔数据集使用另一项目、18089端口和 LOAD_HISTORY=10000。
$capacityProject = 'shopmate-reliability-capacity-new'
docker compose -p $capacityProject -f compose.yaml -f deploy/compose.acceptance.yaml build
$env:LOAD_TEST_ALLOWED = '1'
$env:LOAD_HISTORY = '0'
$env:LOAD_PASSWORD = 'LoadAcceptance123!'
docker compose -p $capacityProject -f compose.yaml -f deploy/compose.acceptance.yaml run --rm --no-deps -e LOAD_TEST_ALLOWED -e LOAD_HISTORY -e LOAD_PASSWORD api node --import tsx scripts/seed-load.ts
docker compose -p $capacityProject -f compose.yaml -f deploy/compose.acceptance.yaml up -d --wait
$env:LOAD_BASE_URL = 'http://127.0.0.1:18088'
$env:LOAD_SECONDS = '600'
$env:LOAD_CONTAINER = "$capacityProject-api-1"
$env:LOAD_REPORT = '.delivery/capacity-small.json'
node --import ./backend/node_modules/tsx/dist/loader.mjs backend/scripts/load.ts
```

负载脚本输出非 2xx（429 单列）、网络错误、P95/P99、吞吐、资源采样、源码摘要及结束时健康状态。存在错误或 P95 大于 2 秒时退出码非零，不能计为验收通过。脚本中的混合写是购物车选择操作，下单和付款容量需要另测，不能直接套用该吞吐。

`fault-acceptance.ts` 会终止和重启 API、持有写锁并创建测试交易。它仅允许 `http://127.0.0.1:18090`，要求 API 的 `shopmate.acceptance=fault` 标签以及同项目 Web 的该端口映射；创建独立项目时设置 `ACCEPTANCE_PURPOSE=fault`。设置 `FAULT_MUTATIONS_ALLOWED=1`、准确 `FAULT_CONTAINER`、`FAULT_ADMIN_PASSWORD` 与新的 `FAULT_REPORT_PATH` 后，在仓库根目录运行：

```powershell
node --import ./backend/node_modules/tsx/dist/loader.mjs backend/scripts/fault-acceptance.ts
```

保留原始报告和退出状态后，可 `docker compose -p <本次验收项目> -f compose.yaml -f deploy/compose.acceptance.yaml stop` 释放资源。不要把验收项目名替换为日常项目后执行造数或故障命令。
