# 日常默认配置与在线备份验收

本轮补测开启 API 请求日志与每日自动备份的单实例部署。此前[可靠性验收](reliability-acceptance.md)关闭了这两项，原吞吐数据仍只适用于原配置。本轮使用独立镜像、Compose 项目、端口、业务卷及宿主机备份目录，不向日常环境创建交易。

## 发现的问题与修复

修复前的万笔订单预检产生 100 个 HTTP 504。全程 P95 为 206 ms，掩盖了备份期间的停顿：自动备份任务耗时 48,096 ms，重叠请求窗口 P95 为 6,789 ms、P99 为 15,009 ms。预检只设置 90 秒，包含请求收尾实际为 96.358 秒；备份后的完整观测窗口未被负载覆盖，因此该结果判定失败，不计入通过数据。[失败原始报告](qa/default-config-20261018/baseline-large-failed.json)

原因是备份副本的 SHA、SQLite 完整性、业务摘要和 8 份备份的保留校验在 API 主线程同步执行，在本机 Windows 绑定目录上阻塞了请求处理。现将复制、校验及保留清理移入单个备份子进程，无等待队列，默认 120 秒截止；异常或超时终止后只清理本次暂存文件。子进程使用只读 WAL 固定快照，复制后立即释放源库读事务，再处理副本与保留清理。固定快照的依据见 [SQLite 隔离说明](https://sqlite.org/isolation.html)；持续写入造成备份复制重启的风险见 [SQLite 备份说明](https://sqlite.org/backup.html)。

复核还发现每次备份会遗留临时副本和已淘汰文件的 WAL/SHM 侧文件。新备份仅将本次独占临时副本转为 DELETE 日志模式，再计算清单，使后续只读检查无需生成侧文件；清理限定本次暂存 UUID 或已校验并选中淘汰的精确备份路径。源库保持 WAL，不扫删未知孤儿文件或仍保留的备份侧文件，参见 [SQLite 只读数据库建议](https://sqlite.org/wal.html#read_only_databases)。

新增 `backup_started`、`backup_completed`、`backup_failed` 日志，以请求无关的 `backupId`、文件名和阶段关联，不记录凭据或数据库正文。只有有效副本创建后才标记当天成功；保留清理失败与创建失败分别处理，详见[运维手册](reliability.md#备份检查与离线恢复)。

验收脚本同时修正了日志收尾校验：通过 Nginx 响应的实际请求 ID 确认日志已接收，避免 Nginx 覆盖客户端 ID 后误报。失败预检的原始报告保留这一已知观察器错误，不能据此否定其中实际发生的 504。

## 方法与门槛

每组以全新数据卷造数并预置 7 份通过校验的 `daily` 备份，服务启动前完成所有准备。随后 50 并发持续 600 秒，自动定时器按默认 60 秒检查，在负载内创建第 8 份并清理最旧一份。没有缩短备份间隔，也没有用手动维护命令代替自动任务。

| 设置 | 本轮实际配置 |
| --- | --- |
| API 请求日志／Nginx 访问日志 | 均开启；Docker json-file 每份 10 MB，保留 3 份 |
| 自动备份 | `BACKUP_DIR=/app/backups`，独立宿主机绑定目录，保留 7 份 |
| 业务写入 | 严格请求标识；持久化订单、通知和清理任务开启 |
| 资源限制 | API 及备份子进程合计 1 GiB，PID 上限 128 |
| 停机配置 | Compose 20 秒宽限，API 内部 15 秒退出截止 |
| 负载 | 90% 商品／本人订单分页／积分读取，10% 幂等购物车选择写入 |
| 数据 | 0 或 10,000 笔合成历史订单；24 商品、48 SKU |

覆盖文件仅用 `SHOPMATE_ENV=acceptance` 和项目标签保护造数与观测脚本；业务源码不按该变量关闭日志、备份或保护机制。基础 Compose 的内存、日志轮转、代理及停机配置继续生效。

负载客户端记录每次请求的开始、结束、状态及是否写入；仅统计生命周期与备份窗口相交的请求。主机与容器时钟在开始和结束测量，按偏差与测量不确定度保守扩大窗口，并额外检查备份前后至少各 1 秒的上下文。窗口必须完全包含在实际负载内，且包含写入；全程与两个窗口均要求无非预期错误、无 429、P95 不超过 2 秒。采用有界内存记录，丢样或备份事件不完整直接失败。

从负载前持续订阅日志，避免 10 MB 日志轮转丢失备份事件；结束时用实际代理请求 ID 确认订阅追平。每秒尝试资源采样，Docker stats 命令实际通常约 2 秒返回一次；同时读取容器 cgroup v2 的 `memory.peak`，后者包含 API、备份子进程及诊断命令的真实容器内存峰值。V8 堆参数不等于子进程总内存上限。

## 最终结果

业务与观察器候选提交为 `ef9dcc976ea7c3c7cd3c80b8247a9613adf2aa34`；随后只追加文档、机器可读证据与实际核对所用的两个只读脚本。运行镜像中 `backend/src`、`shared`、后端包清单按路径排序、统一 LF 后的 SHA-256 为 `bc1aeea5f761c96bad0cc6da7d628129fcbdba7be23d77b389ca35d18b03c650`，共 33 个文件；Nginx 配置摘要为 `16166a291ac52ee59f83bd1b1f8c6cfdd85685b6766656892713cdd422ed0586`。镜像、提交、核对脚本摘要及配置均记入机器报告。

测试主机为 Windows Docker Desktop Linux 引擎，分配 12 个逻辑 CPU、16,341,676,032 字节内存；API 容器内 Node.js 为 24.22.0，本机负载客户端为 24.19.0。主机为共享开发环境，这些数据不外推到其他机器。

| 历史订单 | 实际秒数 | 请求数 | 请求/秒 | 全程 P95 / P99（ms） | 错误 / 429 |
| --- | --- | --- | --- | --- | --- |
| 0 | 600.040 | 520,877 | 868.1 | 103 / 131 | 0 / 0 |
| 10,000 | 600.080 | 327,638 | 546.0 | 160 / 194 | 0 / 0 |

| 历史订单 | 备份及清理耗时（ms） | 备份窗口请求 / 写入 | 窗口 P95 / P99（ms） | 前后上下文 P95 / P99（ms） | 容器内存峰值（MiB） |
| --- | --- | --- | --- | --- | --- |
| 0 | 3,313 | 2,802 / 279 | 123.4 / 142.5 | 121.5 / 141.4 | 594.9 |
| 10,000 | 49,773 | 24,854 / 2,490 | 174.0 / 229.1 | 173.2 / 227.6 | 341.1 |

两组全程及备份窗口均达到门槛，窗口错误和 429 均为 0，无丢样，结束时 healthy、无 OOM、无重启。备份窗口最大请求耗时分别为 198.1 ms 和 1,046.2 ms；时钟扩大余量分别为 278 ms 和 272 ms。日志订阅收到实际代理请求 ID，观测器无错误。间隔采样最大内存分别为 558.5 MiB、322.2 MiB，表中使用更保守的容器累计内存峰值。

每组 25 项编排核对通过，包括 7 份备份全部有效、最旧一份被清理、目录只剩 14 个数据库／清单文件，以及自动备份恢复到新路径后文件 SHA 不变。在线库、负载中的备份、恢复副本各做 21 项只读守恒核对；备份与恢复副本另做 10 项关系、业务和账户会话比较，均通过。在线库允许有更多购物车命令，不要求它与较早备份的字节相同。

两组最终命令记录分别为 52,088 和 32,763 条；历史订单、订单行、库存变动和流水未被本次负载增加或改写。金额核对使用整数分，万笔订单及其收款流水均为合成历史数据，不代表真实支付。两组恢复文件 SHA 分别为 `8b32f9a21f0bef3eaefb1d703a99611f1d09185c85e34f0490e12c34359acc8c`、`4d382e1310c92524fa39a90148e27a24de9121ecb560a6e5ea735920d6f54daf`，与各自备份相同。

机器可读证据：[配置与汇总](qa/default-config-20261018/summary.json)、[小数据负载](qa/default-config-20261018/load-small.json)、[万笔订单负载](qa/default-config-20261018/load-large.json)、[小数据恢复核对](qa/default-config-20261018/verification-small.json)、[万笔恢复核对](qa/default-config-20261018/verification-large.json)、[小数据守恒与两库比较](qa/default-config-20261018/invariants-small.json)、[万笔守恒与两库比较](qa/default-config-20261018/invariants-large.json)。这些文件只包含配置白名单、数量、统计及摘要，不提交数据库、备份或凭据。

完整后端回归 126 项及类型检查已通过，包括真实备份子进程、WAL 并发写、错误后重试、超时／终止、旧格式侧文件清理、备份窗口统计及代理请求 ID 关联。交付门槛还包括最终提交 SHA 的 GitHub Actions 全部检查：前后端类型检查、前端 lint／构建／单元、浏览器回归、容器闭环与生产依赖审计。交付回复给出准确最终 SHA 和 CI 链接，不以旧提交的绿色检查替代。

## 复跑

需要本机 Node.js 24、`npm --prefix backend ci` 和可用 Docker。以下命令在仓库根目录执行，项目名、端口和目录必须本次专用；第二组另用新项目、新备份目录、18095 端口及 `LOAD_HISTORY=10000`。Linux 绑定目录须先按[部署说明](../README.md#3-启动服务)设置属主权限。

```powershell
$loadProject = 'shopmate-reliability-default-new-small'
$env:ACCEPTANCE_TAG = 'default-config-new'
$env:VCS_REF = (git rev-parse HEAD).Trim()
$env:APP_PORT = '18094'
$env:APP_ORIGINS = 'http://127.0.0.1:18094'
$env:ADMIN_PASSWORD = 'AcceptanceOnly123!'
$env:LOAD_PASSWORD = 'LoadAcceptance123!'
$env:LOAD_TEST_ALLOWED = '1'
$env:LOAD_HISTORY = '0'
$env:BACKUP_PATH = Join-Path (Get-Location) ".delivery/$loadProject/backups"
New-Item -ItemType Directory -Path $env:BACKUP_PATH | Out-Null
docker compose -p $loadProject -f compose.yaml -f deploy/compose.production-load.yaml build
docker compose -p $loadProject -f compose.yaml -f deploy/compose.production-load.yaml run --rm --no-deps -e LOAD_TEST_ALLOWED -e LOAD_HISTORY -e LOAD_PASSWORD api node --import tsx scripts/seed-load.ts
docker compose -p $loadProject -f compose.yaml -f deploy/compose.production-load.yaml run --rm --no-deps -e LOAD_TEST_ALLOWED -e LOAD_HISTORY api node --import tsx scripts/prepare-load-backups.ts
docker compose -p $loadProject -f compose.yaml -f deploy/compose.production-load.yaml up -d --wait
$env:LOAD_BASE_URL = $env:APP_ORIGINS
$env:LOAD_CONTAINER = "$loadProject-api-1"
$env:LOAD_OBSERVE_BACKUPS = '1'
$env:LOAD_SECONDS = '600'
$env:LOAD_REPORT = ".delivery/$loadProject/load.json"
node --import ./backend/node_modules/tsx/dist/loader.mjs backend/scripts/load.ts
if ($LASTEXITCODE) { throw '压测未达到门槛，保存报告并排查' }
```

逐条检查 Docker 命令退出码，任一失败即停止。不要叠加会关闭日志和备份的 `compose.acceptance.yaml`。负载脚本会检查项目标签、端口、卷、独立备份绑定目录、内存／PID／日志限制；禁止日常端口 18086。造数、预置备份与验证都只针对独立环境。

保留报告后，通过维护 `inspect` 命令逐份校验剩余 7 份备份，再将自动备份恢复到新的离线目标，比较备份与恢复副本摘要及业务守恒；不要覆盖日常业务库。恢复命令与停写要求见[运维手册](reliability.md#备份检查与离线恢复)。

负载结束后可用[只读守恒脚本](../backend/scripts/verify-load-invariants.mjs)核对合成种子的 21 项约束；它只适用于 `seed-load.ts` 生成的这两种数据集。脚本输出数量和摘要，不输出账号、地址或业务正文。当前服务仍运行时使用只读事务，不把它当作全局停写快照：

```powershell
docker cp backend/scripts/verify-load-invariants.mjs "${env:LOAD_CONTAINER}:/tmp/verify-load-invariants.mjs"
docker exec -e SHOPMATE_ENV=acceptance -e LOAD_TEST_ALLOWED=1 -e "LOAD_HISTORY=$env:LOAD_HISTORY" $env:LOAD_CONTAINER node /tmp/verify-load-invariants.mjs
```

恢复副本也使用同一脚本和准确 `DATABASE_PATH` 检查；另用[两库只读比较脚本](../backend/scripts/compare-database-snapshots.mjs)比较自动备份与其恢复副本，核对账户会话、旧 JSON、业务字段、SKU、外键和完整性，并额外比较两个文件 SHA。不要拿负载结束后的在线库与负载中较早的备份要求字节相同，购物车和命令结果仍会继续增长。

停止本次验收容器可使用：

```powershell
docker compose -p $loadProject -f compose.yaml -f deploy/compose.production-load.yaml stop
```

## 结论边界

该混合负载的吞吐不能换算为下单／支付吞吐，也不能证明多实例容量、长期运行、真实磁盘故障或整机丢失恢复。备份与业务卷分离，但仍在同一开发主机；生产使用还需独立介质和容量、权限、失败告警。此次仅在隔离环境验证修复，日常容器未重建，仍运行此前交付版本。

进程被强制终止或整机断电仍可能留下不完整暂存文件；无有效清单的文件不算可用备份。先确认相关进程已停止并保留诊断证据，再按精确路径人工处理，不通过通配清理或删除业务卷解决。
