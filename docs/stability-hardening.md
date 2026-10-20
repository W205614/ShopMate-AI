# 稳定性加固与专项验收

本次面向本机 Docker 的稳定演示、小范围试用，保留单店、单仓、单 API 进程、SQLite、模拟支付／退款／物流及计划停机。异机备份、HTTPS 和告警接收端未接通前，不认定具备公网营业或整机故障的恢复保障。

## 实现

- `/api/state` 永久返回 `410 LEGACY_STATE_DISABLED`；页面和历史验收使用既有 bootstrap、分页、详情及请求恢复接口，不保留全量读取逃生开关。
- 命令按用户读取购物车、地址、通知，报价和下单恢复按明确记录 ID 读取。局部快照仅保存已装载范围，拒绝覆盖被排除的键及写入其他用户记录；库存检查仍包含全局有效预占。
- 支付／退款新增库存流水、财务流水和积分采用仅追加范围；通知以确定性 ID 单条插入，与任务完成标记一起提交。任务每250ms轮询、每批最多20条，防止交易混合负载下旧的每秒10条处理上限形成持续积压。短期内部快照显式结束生命周期，避免等待GC时为未读取领域保留无关数据。
- 未下单过期报价和过期业务请求通过索引定向清理；已成交报价和核心幂等结果继续保留，不以 TTL 删除来掩盖增长问题。管理诊断提供记录数、有效载荷字节及采样间增长量，这些字节不等于 SQLite 占用空间。
- 所有请求包括提前拒绝的 429 进入统一请求日志，429／数据库繁忙提供 `Retry-After`。管理诊断仅对有 `settings` 权限的员工开放，输出队列、备份、版本和计数，不含客户正文或凭据。
- 备份成功／失败／副本恢复点持久化。上次成功 22 小时 57 分后开始调度，为一分钟轮询及两分钟子进程超时预留空间。目标23小时并非故障条件下的保证；最近7份自动备份不等于七个自然日。
- SQLite 复制、完整性检查和业务摘要先在容器本地临时目录执行，再顺序发布到备份目录并校验 SHA；接收端及保留清理的校验也采用本地暂存。摘要按行计算，保持旧清单格式，备份仍受 120 秒及子进程堆上限约束，日志分别记录复制、校验、发布、保留和副本阶段耗时。

## 测试方法和证据边界

本地仅运行变更及直接影响的回归；最终完整前后端、浏览器、容器和依赖检查由最终提交 SHA 的 GitHub Actions 执行。

新增定向场景覆盖局部快照跨用户保护、历史报价保留、通知重投、备份跨重启、接收端文件对校验、诊断权限、429日志、监控阈值和维护静默。真实回环 HTTP 假模型验证超时、429、无效JSON及文档向量化失败时普通下单仍可完成，事务不跨外部调用。

专项负载使用独立 `shopmate-reliability-*` Compose 项目、验收专用1809x端口、独立业务卷及备份／接收目录，不连接日常18086或其数据卷。数据包含50个普通账号、一万笔历史订单、一万份已成交报价、一万条基线幂等记录和已完成任务、一万条通知、1001条购物车及50笔有效预占。

正式验收依次5／20／50并发各600秒，这三档采用闭环请求、不额外插入等待；随后20并发5400秒，每轮加入500ms用户思考时间观察持续运行。工作负载按循环步骤70%分页读取、20%购物车／报价、10%交易状态机组织；交易中的详情读取单独计数，实际HTTP比例见报告。状态机交替取消订单和未发货付款／售后／退款。模拟模型故障与文档失败仅通过隔离网络假服务注入，不调用真实收费模型，不把预期任务失败算作正常交易5xx。

每一档分别统计P95／P99、错误、429和实际写请求量，备份窗口另行统计；核对容器内存峰值、重启、OOM及最终健康。只读验收器在显式读取事务中检查库存、预占、SKU与订单行投影、收退款次数和金额、归属以及原历史和幂等记录摘要。备份、文件副本和新路径恢复分别核验，不要求在线库与较早恢复点的文件字节相同。

## 2026-10-20 正式结果

实现及负载脚本提交为 `cf712796693ad774480135dd660c69b2a980fe6d`，[该提交CI通过](https://github.com/W205614/ShopMate-AI/actions/runs/39366161779)。正式运行从UTC 03:51:53至05:51:56（北京时间11:51至13:51），实际7202.647秒，脚本退出码0。后续仅追加交付文档及脱敏证据；最终交付回复另给出最终SHA及其CI链接，不以实现提交的绿色检查代替最终检查。

| 环境 | 实际值 |
| --- | --- |
| Compose项目／Web端口 | `shopmate-reliability-stability-v3-20261020`／127.0.0.1:18099 |
| Docker可用资源 | Linux x86_64，12 CPU，15.22 GiB；API及其子进程合计1 GiB、PID上限128 |
| API运行时 | Node.js v24.22.0，SQLite 3.53.4；日志和自动备份均启用 |
| API验收镜像 | `sha256:8c1874ae781d245943c6a1e03a18eb70b3a4f1a49919ca9c8fea060c3e051b2f` |
| 运行源码摘要 | `d10193b6aca0eadc2944b5a6c2a9d87154d24eb344d9ee229769841c8a2120d7`；43个后端源码、shared及后端包清单文件，统一LF后按路径计算；开始、结束一致 |

| 并发工作用户 | 负载方式／时长 | 请求数 | 请求/秒 | 写请求/秒 | P95 | P99 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 5 | 闭环无额外等待／10分钟 | 153,778 | 256.3 | 74.7 | 61 ms | 93 ms |
| 20 | 闭环无额外等待／10分钟 | 133,833 | 223.0 | 65.0 | 200 ms | 274 ms |
| 50 | 闭环无额外等待／10分钟 | 125,140 | 208.5 | 60.8 | 438 ms | 586 ms |
| 20 | 每轮500ms思考时间／90分钟 | 207,621 | 38.4 | 11.2 | 108 ms | 149 ms |

合计620,372次普通请求，全部HTTP 200，网络错误、非预期业务错误、状态机断言失败及429均为0。实际439,486次读、180,886次写（70.842%／29.158%），完成17,206轮取消或付款／退款状态流转。写请求包含购物车和报价，不能视为支付吞吐；最后90分钟也不代表持续20个在途请求。最终27,292笔订单含原一万笔历史及50笔预置订单，幂等结果增至191,128条；在线只读校验20项全部通过，原历史订单、基线幂等及已完成任务摘要均未改变。[原始负载](qa/stability-20261020/load.json)、[独立门槛汇总](qa/stability-20261020/summary.json)、[在线守恒](qa/stability-20261020/verify-live.json)、[生成订单状态](qa/stability-20261020/transaction-branches.json)

### 备份窗口、资源与故障

在隔离库回拨持久化成功时间，由原每分钟自动调度器触发三轮备份；没有修改系统时间、23小时目标间隔或日常数据库。启动后另有一轮备份在负载开始前已完成，不计入以下窗口。本轮不等于自然连续运行23小时的验证，跨重启及调度边界另由定向测试覆盖。

| 所在阶段 | 数据库大小 | 完整备份及副本耗时 | 重叠写请求 | 窗口P95 | 窗口P99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5并发 | 71.9 MB | 13.754秒 | 1,023 | 61.5 ms | 80.0 ms |
| 50并发 | 241.4 MB | 41.836秒 | 2,085 | 485.3 ms | 2,345.2 ms |
| 20用户持续运行 | 375.4 MB | 62.409秒 | 683 | 129.0 ms | 215.0 ms |

三个备份窗口及前后上下文均完整覆盖、有写入、无错误或429、无丢样，分别满足P95≤2秒、P99≤5秒。50并发备份窗口的最大请求耗时为3.769秒；不能仅用全程P99为439ms来描述备份期间的尾延迟。实际保留四份有效自动备份，上限七份的选择与清理另有定向回归覆盖。[调度模拟记录](qa/stability-20261020/backup-schedule-simulation.json)

API累计cgroup内存峰值899.1 MiB／1 GiB，周期采样最大504 MiB；三个容器均保持同一ID、启动时间和重启次数，健康、无OOM，cgroup的oom、oom_kill和max事件均为0。持续阶段前后30分钟的内存采样中位数从397.6升至486.6 MiB（增加89 MiB）；结束后单次分类为匿名内存约79.3 MiB、文件缓存约361.2 MiB。内存包含文件缓存和备份子进程，不能据此认定泄漏，也不能证明长期无泄漏；峰值余量约12%，需随数据量继续观测。[内存分类](qa/stability-20261020/memory-detail.json)

任务周期采样最大待处理14条、最老到期等待325ms、失败0；结束时1条未来调度任务，最老到期等待0。AI假服务实际出现429、无效JSON、超时、503分别31／31／30／30次，121个客服任务及1个文档任务按预期失败，停止注入后无排队／运行任务。文档故障与普通请求有时间重叠。LLM和Embedding均指向隔离网络本地provider、密钥为合成占位值、reranker关闭，没有调用真实收费模型；该假服务始终注入故障，不验证恢复到健康上游后的回答质量。[模型隔离](qa/stability-20261020/provider-isolation.json)

锁竞争、重复付款／退款、丢响应、SIGKILL恢复及认证保护在业务源码相同的 `fee6b2c` 上复验通过，后续仅调整备份和验收路径，未重复未变业务压测。50次付款／退款分别只产生一笔流水；库存10件的50次并发提交为10次成功、40次预期拒绝；数据库锁竞争产生一次预期503，原标识重试成功；认证故障的401／429单独统计。[故障报告](qa/stability-20261020/fault.json)

### 恢复与发布边界

375.4 MB自动备份恢复到全新路径，文件恢复及完整检查耗时25.228秒。备份、同机接收目录及恢复文件分别核对库存、账户关系、订单、流水及历史记录，并比较文件SHA；原始清单同时包含账户、会话和AI持久化表摘要。完整性、业务关系和原记录保护核对均通过，三份数据库字节一致。[恢复耗时](qa/stability-20261020/restore-timing.json)、[三路文件摘要](qa/stability-20261020/recovery-hashes.json)、[备份守恒](qa/stability-20261020/verify-backup.json)、[副本守恒](qa/stability-20261020/verify-replica.json)、[恢复守恒](qa/stability-20261020/verify-restored.json)

25秒仅是离线文件恢复及检查，不包含整机重建或完整服务恢复。接收目录和原卷仍在同一主机，不据此认定整机故障的RPO24小时达标。本机试用以实测的20用户持续场景为起点，50并发仅有十分钟阶梯证据；这些闭环结果不构成开放流量SLA、无限数据增长容量或企业高可用承诺。

从恢复维护命令开始到三路守恒及文件摘要收尾的完整演练耗时见[恢复汇总](qa/stability-20261020/recovery-summary.json)，低于一小时。代理后的外部探测执行一次通过、响应14ms，明确输出“告警未接通”；本轮没有配置持续托管或真实webhook接收端，不能把一次探测当作告警闭环。[探测记录](qa/stability-20261020/monitor-once.json)

## 预检发现与修复依据

两次中止的预检均不计为验收通过。第一次混合交易负载暴露旧通知任务每秒最多10条的消费上限，采样积压3389条、最老等待130秒，因此改为每250ms最多处理20条，并重新使用新卷造数。[队列预检记录](qa/stability-20261020/preflight-queue-aborted.json)

第二次预检的三档普通请求均无错误，但在50并发时两次自动备份超过120秒，所以中止了后续持续运行。对同一份冻结的287 MB数据只读剖析：容器本地复制与完整性检查合计2.913秒，Windows绑定目录为143.853秒；增大复制批次仍需135.760秒。原工作进程已经固定WAL读取快照，不能直接将超时归因于备份不断重启。[备份中止记录](qa/stability-20261020/preflight-backup-aborted.json)、[I/O剖析](qa/stability-20261020/backup-io-profile.json)

修复将全部SQLite随机页操作移至本地暂存，并流式计算兼容旧清单的摘要。包含旧备份保留检查、287 MB新备份和接收副本验证的完整静态流程耗时45.407秒，维持120秒及192 MB子进程堆限制；源数据库、WAL和旧备份摘要未变。这是只读源码挂载剖析，最终镜像的负载结果另行记录。[完整流程剖析](qa/stability-20261020/backup-pipeline-profile.json)

## 复跑

仅对新项目、新卷执行造数；已有环境不要反复运行造数脚本。以下示例使用专用验收凭据，与日常 `.env` 无关。Linux绑定目录须先按README设置UID1000写权限。

```powershell
$stabilityProject = 'shopmate-reliability-stability-new'
$env:ACCEPTANCE_TAG = 'stability-new'
$env:VCS_REF = (git rev-parse HEAD).Trim()
$env:APP_PORT = '18096'
$env:APP_ORIGINS = 'http://127.0.0.1:18096'
$env:ADMIN_USERNAME = 'stability_owner'
$env:ADMIN_PASSWORD = 'AcceptanceAdmin123!'
$env:LOAD_ADMIN_USERNAME = $env:ADMIN_USERNAME
$env:LOAD_ADMIN_PASSWORD = $env:ADMIN_PASSWORD
$env:LOAD_PASSWORD = 'AcceptanceUser123!'
$env:LOAD_TEST_ALLOWED = '1'
$env:LOAD_HISTORY = '10000'
$env:BACKUP_PATH = Join-Path (Get-Location) ".delivery/$stabilityProject/backups"
$env:REPLICA_PATH = Join-Path (Get-Location) ".delivery/$stabilityProject/replica"
New-Item -ItemType Directory -Force $env:BACKUP_PATH,$env:REPLICA_PATH | Out-Null
$stabilityCompose = @('-p',$stabilityProject,'-f','compose.yaml','-f','deploy/compose.production-load.yaml','-f','deploy/compose.stability.yaml')
docker compose @stabilityCompose build
docker compose @stabilityCompose run --rm --no-deps -e LOAD_TEST_ALLOWED -e LOAD_HISTORY -e LOAD_PASSWORD api node --import tsx scripts/seed-stability.ts
# 服务启动前捕获基线；命令仅输出数量和摘要。
docker compose @stabilityCompose run --rm --no-deps -e LOAD_TEST_ALLOWED api node --import tsx scripts/verify-stability.ts --database /app/data/shopmate.sqlite --capture-baseline
docker compose @stabilityCompose up -d --wait
$env:LOAD_BASE_URL = $env:APP_ORIGINS
$env:LOAD_CONTAINER = "$stabilityProject-api-1"
$env:LOAD_REPORT = ".delivery/$stabilityProject/load.json"
node --import ./backend/node_modules/tsx/dist/loader.mjs backend/scripts/stability-load.ts
```

逐条检查退出码；基线JSON保存到专用目录，复制到验收容器后用 `verify-stability.ts --database 路径 --baseline 基线路径` 比较。`STABILITY_SMOKE=1` 仅执行短时脚本检查，不能替代两小时正式验收。备份、副本和离线恢复操作见运维手册，所有目标必须为新的验收路径。

复现负载中的备份时，在另一终端设置相同 `LOAD_CONTAINER`，确认已处于相应阶段且上一轮备份完成后执行。例子为50并发阶段；另外两次分别传 `5-clients`、`20-clients-endurance`。该工具只回拨隔离库中的成功时间，不能对日常库执行，也不应通过更改生产间隔替代。

```powershell
$target = $env:LOAD_CONTAINER
if ($target -notmatch '^shopmate-reliability-[a-z0-9-]+-api-1$') { throw 'Isolated target required' }
$info = (docker inspect $target | ConvertFrom-Json)[0]
if ($LASTEXITCODE -ne 0 -or $info.Config.Labels.'shopmate.acceptance' -ne 'production-load' -or
    $info.Config.Labels.'com.docker.compose.project' -ne $target.Substring(0,$target.Length-6)) {
  throw 'Isolation labels do not match'
}
docker cp docs/qa/stability-20261020/force-backup-due.mjs "${target}:/tmp/force-backup-due.mjs"
if ($LASTEXITCODE -ne 0) { throw 'Copy failed' }
docker exec -e LOAD_TEST_ALLOWED=1 $target node /tmp/force-backup-due.mjs 50-clients
if ($LASTEXITCODE -ne 0) { throw 'Schedule simulation failed' }
```

## 发布及上线门槛

固定最终提交及镜像摘要；发布前一致备份并保留旧镜像，计划停机，重建后核对版本、健康、账号及业务摘要。若升级后已有新写入，先保留新库证据并评估前向修复，不直接恢复旧库。整个过程保留原业务卷、凭据及回滚材料，不清理其他项目。

本机恢复目标为RTO一小时；RPO24小时的整机故障结论必须在独立主机／介质接收完整备份文件对、目标端校验及恢复演练后才能成立。对外试用还需HTTPS、Secure Cookie、准确访问源、管理入口限制及实际告警接收人。真实营业另需支付回调验签、重复乱序处理、退款确认和渠道对账，本轮没有增加这些业务功能。
