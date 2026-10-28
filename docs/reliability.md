# 存储、稳定性与故障处理

本项目的运行边界是单店、单仓、一个 API 进程、一份本地 SQLite 文件。支付、物流和退款仍为业务模拟。文件备份、健康检查和容器重启策略不能证明生产级可用性；容量结论应以交付报告中的环境、数据量、负载和提交 SHA 为准。

## 存储和并发规则

- `accounts`、`sessions` 保留原账号、密码散列、会话及 ID；业务迁移版本为 4，存储结构版本为 1。启动拒绝高于当前程序支持范围的版本。
- 业务按集合落入 `biz_*` 表，每条记录独立存储；状态、所属用户、时间、商品等字段投影为可索引列。商品 SKU、订单行另有关系表、唯一键、库存/金额检查及父记录外键。嵌套业务快照仍保存为记录 JSON，此结构不等于完全第三范式建模。
- 旧 `state` JSON 保留原始字节，迁移后由触发器禁止更新和删除。新写入只更新变化的记录及相应 SKU/订单行，不双写旧状态。迁移在同一事务中完成，失败回滚，重复启动不重复迁移。
- 写事务使用 `BEGIN IMMEDIATE`，一次完成校验、库存/金额变更、业务流水及同事务命令结果。事务回调禁止返回 Promise；网络调用和密码计算不进入写事务。SQLite 配置 WAL、外键检查和 5 秒锁等待。
- 新订单使用 `reserved-v1` 预占规则，报价不预占；账面库存减有效待付款预占为可售量。付款、取消、超时均按服务端最新状态处理。历史订单不补写新库存、积分或售后策略，原期限不延长。
- 前端列表使用 `/api/bootstrap` 和 `/api/collections/:collection` 分领域查询、SQL 筛选分页，普通页最大 100 条；库存工作台按 SKU 分页。`/api/state` 已永久退出，固定返回 `410 LEGACY_STATE_DISABLED`，不提供绕过开关；历史验收也通过分页接口核对。
- 客服会话默认按等待人工、人工接待、模拟客服、已关闭排序，各状态内按创建时间和 ID 倒序。`locate=<会话 ID>` 在同一筛选条件和权限范围内计算全局页码，返回 `located`；筛选排除目标时不会擅自清除筛选。评价和领券关联的订单上下文遵循订单权限：无订单读取权限的员工只得到订单 ID、所属用户、状态及评价资格所需的条目数量字段，不包含收货地址、电话或财务金额。
- 财务列表的 `totals` 使用同一筛选条件汇总全量匹配流水，返回十进制整数字符串，以 BigInt 累加避免 Number 精度和 SQLite 整数求和溢出。净收支不等于利润。

## 正常运行和观测

日常 Compose 默认设置 `LOG_REQUESTS=true`、`BACKUP_DIR=/app/backups`，同时开启 API 请求日志和每日自动备份。`api_data` 保存 `/app/data/shopmate.sqlite`，宿主机 `BACKUP_PATH` 独立挂载到 `/app/backups`。生产环境应为备份目录配置独立介质、访问控制及容量监控；同机备份无法覆盖整机丢失。

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

后台 `job_queue` 持久化通知和每分钟超时/清理任务，每250ms轮询，每次最多取20个任务；单条通知直接插入，避免完整集合序列化，通知记录和任务完成标记在同一事务提交。该批量上限用于限制单轮占用，不承诺固定任务吞吐；需观测积压和最老等待时间。失败按指数间隔重试，最多5次，随后保留为failed。

店主在“经营工作台 → 运行状态”查看当前版本、请求繁忙、任务积压、AI任务和备份状态；进入时读取，可手动刷新，不持续轮询。这里显示的是应用诊断，不包含宿主机磁盘检查或外部告警已接通的承诺。“后台任务”支持状态筛选、分页和北京时间。`GET /api/admin/jobs?status=failed&page=1&pageSize=20` 返回 `items,total,page,pageSize,pages`；每项包含 `retryVersion`，不返回任务载荷。

先排除失败原因，再在页面确认“重试任务”。底层使用 `POST /api/actions/retryJob`，请求为 `{args:[任务ID,读取时的retryVersion],requestId:唯一请求标识}`，要求有效管理会话、`settings` 权限及正常请求来源头。只允许失败且类型、载荷有效的通知和过期清理任务；通知还检查账号及关联订单归属。未知类型或损坏数据拒绝恢复，保留现场排查。缺失任务返回404；状态或版本变化返回409，刷新后重新核对。

重试保留原任务ID和内容，更新为pending、清零自动尝试计数、立即调度并递增恢复版本；更新、幂等结果与脱敏审计在同一事务提交。原请求可查询 `/api/requests/:requestId?method=retryJob&role=admin`，重复提交返回原结果，旧页面不能重置新一轮失败。通知使用固定任务派生ID，重复投递不会重复生成通知。不要手工改库代替这一流程；此入口不重试AI客服、文档或备份任务，它们仍使用各自原有恢复入口。

## 备份、检查与离线恢复

### Windows 本机只保留最新一份

需要旧文件进入 Windows 回收站时，设置本机 `.env` 的 `BACKUP_RETENTION_MODE=external`。容器继续生成与校验备份，宿主机运行 `scripts/retain_latest_backup.py`：合并手动、current、升级前和 daily 完整备份，调用现有维护检查逐份验证，保留时间最新的一对数据库／清单，将其他有效备份送入当前 Windows 用户的回收站。未配齐清单、校验失败、时间异常、未知来源或运行中变化的文件保留并记录原因；没有有效恢复点时不清理。该工具不清空回收站。

先预览（默认不回收），确认项目、备份目录和 Node.js 绝对路径；再加 `--execute` 执行：

```powershell
python -X utf8 scripts/retain_latest_backup.py --root E:\project\ShopMate-AI --backup-dir E:\project\ShopMate-AI\backups --node E:\download\NodeJS\node.exe
```

本机运维任务 `ShopMate-AI-LatestBackupRetention` 在当前用户登录期间每分钟检查一次，旧文件通常在新备份验证完成后的一分钟内回收；互斥锁避免重叠。任务以当前交互用户的普通权限运行，依赖该项目源码、后端依赖、本机 Python／Node.js 及回收站可用。失败时保留文件，事件记录在 `.delivery/latest-backup-retention/events.jsonl`，不做永久删除兜底。离线或未登录时任务不执行；下一次检查会重新验证后处理。仅设置 external 而没有安装并启用宿主机任务，不会自动清理。

任务通过 `pythonw.exe` 隐藏运行，Node.js 校验与 `whoami` 子进程显式使用 Windows `CREATE_NO_WINDOW`，避免每分钟检查时闪现控制台。回收操作关闭确认、进度和错误界面；失败保留文件并写日志，不弹出确认框或自动转为永久删除。

启用 `BACKUP_DIR` 后，API 每 60 秒检查最近成功恢复点。成功时间、文件路径和失败状态持久化到 `backup_runtime`，重启不会丢失标记；首次没有成功恢复点或文件／清单缺失时才重新备份。上次成功后 22 小时 57 分开始调度，给轮询和最长 120 秒子进程预留余量，目标是在 23 小时内更新恢复点；故障时该目标可能失守，必须结合告警处置，不能视为保证。文件名日期使用 UTC，不再按日期字符串去重。

每次只允许一个自动备份子进程，不排队；已有任务未结束时跳过本次检查。仅自动清理带有效清单、原因是 daily、名称为 `shopmate-daily-*.sqlite` 的旧文件，保留最新 7 份；这是份数而不是保证七个自然日，手动、升级前和恢复前备份不参与自动清理。

`BACKUP_RETENTION_MODE` 默认 `internal`，使用上述容器内7份保留规则；设为 `external` 时，容器仍生成并校验新备份、更新成功恢复点和可选副本，但不删除旧备份，由宿主机保留程序负责回收。只接受 `internal`／`external`，其他值使备份任务明确失败，不能静默退回删除模式。完成日志包含 `retentionMode`。Windows 希望只保留最新一份并把旧文件移入系统回收站时，应先配置并验证宿主机保留任务，再在本机未跟踪的 `.env` 设置 `BACKUP_RETENTION_MODE=external`；宿主机任务失败时旧份会保留，需检查任务结果和磁盘容量。切换该选项本身不会安装或启动宿主机任务。

自动备份的复制、校验和保留清理都在独立子进程执行，不在 API 请求事件循环内处理。子进程以只读连接打开 WAL 数据库，通过事务及首次读取固定快照，再使用 Node 的 SQLite backup API 复制其中已提交的数据；复制完成立即释放源库读事务，再对副本计算摘要、检查完整性及清理旧备份，避免校验和保留扫描继续占住源库 WAL 快照。这种隔离仍会共享容器的 CPU、内存和磁盘资源，不能推导备份期间零延迟影响。

单次自动备份子进程任务默认最多 120 秒，超时会被终止。API 停机时停止调度并等待在途请求和备份；15 秒退出期限到达后会关闭连接、终止备份子进程并以非零状态退出。子进程设置 V8 老生代堆上限 192 MiB、半空间上限 16 MiB；这些是 V8 堆参数，不是进程总内存保证，也不包含全部 Buffer、SQLite 和其他本机内存。API 与备份子进程仍共同受 Compose 的 1 GiB 容器内存限制。

每份 `.sqlite` 同时生成 `.sqlite.manifest.json`，清单包含 SHA-256、结构/业务版本、修订号、集合数量及业务/账号/会话摘要。检查执行文件校验和、SQLite integrity_check、外键检查及摘要比对。备份清单不包含密码散列或会话原文；备份数据库本身含敏感数据，需要限制访问。

备份复制完成并释放源库快照后，只将本次独占的临时副本切换为 `journal_mode=DELETE`，再计算文件 SHA 和生成清单；业务源库继续使用 WAL。正常完成的备份是可独立读取的主文件，后续只读校验不会因副本仍处于 WAL 模式而持续产生侧文件。任务的 `finally` 只清理本次 UUID 临时路径及其清单、`-wal`、`-shm`、`-journal`；保留清理只删除已通过清单校验且被选为淘汰对象的精确备份路径及对应侧文件，不扫描删除保留副本或无法确认归属的孤立文件。

15 秒停机期限触发强制退出、进程被强制终止或整机断电时，清理代码可能来不及完成，目录可能留有 `.partial-<UUID>`、侧文件或尚未配齐清单的最终文件。缺少有效清单或未通过完整校验的文件不能计为可用备份，也不会作为有效每日备份参与保留清理。处置前应停止相关 API、备份和维护进程，保留文件及日志证据，核对精确路径、任务 UUID 和文件归属，再仅处理已确认属于失败任务的残留；不要通过通配符批量删除数据库侧文件，尤其不能把业务源库的 WAL 当作备份残留。

自动备份输出 `backup_started`、`backup_completed` 或 `backup_failed` 结构化事件，同次任务通过 `backupId` 和 `file` 关联，并带有时间及 `phase`。阶段为 `backup`、`retention` 或可选的 `replica`；只有有效备份创建并校验成功、子进程报告 `created` 后才持久化本地成功恢复点。复制或校验失败会在后续检查重试；本地副本已成功而保留清理／副本复制失败时，本地成功恢复点仍保留，同时记录失败供告警，避免无限重复创建大文件。错误日志仅含固定代码，不输出原始异常内容。修复目标权限、容量等问题后，可用下述 `replicate` 命令重新复制已有有效备份，不必重建本地备份。

可选 `BACKUP_REPLICA_DIR` 必须另行挂载到容器；默认 Compose 不会把任意宿主机目录自动暴露给 API。子进程成对复制数据库和清单，重新校验目标后记录副本恢复点。目标存在即拒绝覆盖，不自动清理接收目录，需配置接收端空间监控和保留策略。普通目录复制始终标记 `offhostVerified=false`，本机独立目录不能证明整机故障恢复。

```powershell
npm --prefix backend run maintenance -- replicate backups/已校验的备份.sqlite 独立接收目录
npm --prefix backend run maintenance -- verify-replica 独立接收目录/已校验的备份.sqlite
```

真正异机环境须将完整文件对传输到独立主机／介质，在目标机执行同版本 `verify-replica`，并进行离线恢复演练，再评估 RPO 24 小时、RTO 1 小时。接口、宿主机探测、维护静默和通知配置见[运行监控](monitoring.md)。

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
| 磁盘不足、备份失败 | 检查业务卷和备份目录的空间及权限，按 `backupId`、`file` 和 `phase` 关联日志。复制或校验失败未标记当天成功，下次检查会重试；`retention` 失败应核验新备份并处理旧文件清理，不会同日反复造份。保护业务库，只处理有明确保留策略的历史备份或日志。 |
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

以下示例只针对新建验收项目；每个数据集使用新的项目名及数据卷。`seed-load.ts` 只允许验收环境，遇到已有 loaduser 会拒绝重复造数。端口 18086 禁止用于负载脚本。此处 `compose.acceptance.yaml` 会关闭 API 请求日志和自动备份，并使用独立备份卷；其负载结果不能代替日常默认配置或备份执行期间的容量结论。复现日常配置时应使用单独的 `compose.production-load.yaml` 覆盖文件，保持日志和备份开启，并为每组数据设置独立的宿主机 `BACKUP_PATH`；不要叠加两个验收覆盖文件。

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
