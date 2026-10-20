# 稳定性加固与专项验收

本次面向本机 Docker 的稳定演示、小范围试用，保留单店、单仓、单 API 进程、SQLite、模拟支付／退款／物流及计划停机。异机备份、HTTPS 和告警接收端未接通前，不认定具备公网营业或整机故障的恢复保障。

## 实现

- `/api/state` 永久返回 `410 LEGACY_STATE_DISABLED`；页面和历史验收使用既有 bootstrap、分页、详情及请求恢复接口，不保留全量读取逃生开关。
- 命令按用户读取购物车、地址、通知，报价和下单恢复按明确记录 ID 读取。局部快照仅保存已装载范围，拒绝覆盖被排除的键及写入其他用户记录；库存检查仍包含全局有效预占。
- 支付／退款新增库存流水、财务流水和积分采用仅追加范围；通知以确定性 ID 单条插入，与任务完成标记一起提交。短期内部快照显式结束生命周期，避免等待 GC 时为未读取领域保留无关数据。
- 未下单过期报价和过期业务请求通过索引定向清理；已成交报价和核心幂等结果继续保留，不以 TTL 删除来掩盖增长问题。管理诊断提供记录数、有效载荷字节及采样间增长量，这些字节不等于 SQLite 占用空间。
- 所有请求包括提前拒绝的 429 进入统一请求日志，429／数据库繁忙提供 `Retry-After`。管理诊断仅对有 `settings` 权限的员工开放，输出队列、备份、版本和计数，不含客户正文或凭据。
- 备份成功／失败／副本恢复点持久化。上次成功 22 小时 57 分后开始调度，为一分钟轮询及两分钟子进程超时预留空间。目标23小时并非故障条件下的保证；最近7份自动备份不等于七个自然日。

## 测试方法和证据边界

本地仅运行变更及直接影响的回归；最终完整前后端、浏览器、容器和依赖检查由最终提交 SHA 的 GitHub Actions 执行。

新增定向场景覆盖局部快照跨用户保护、历史报价保留、通知重投、备份跨重启、接收端文件对校验、诊断权限、429日志、监控阈值和维护静默。真实回环 HTTP 假模型验证超时、429、无效JSON及文档向量化失败时普通下单仍可完成，事务不跨外部调用。

专项负载使用独立 `shopmate-reliability-*` Compose 项目、18096端口、独立业务卷及备份／接收目录，不连接日常18086或其数据卷。数据包含50个普通账号、一万笔历史订单、一万份已成交报价、一万条基线幂等记录和已完成任务、一万条通知、1001条购物车及50笔有效预占。

正式验收依次5／20／50并发各600秒，这三档采用闭环请求、不额外插入等待；随后20并发5400秒，每轮加入500ms用户思考时间观察持续运行。工作负载按循环步骤70%分页读取、20%购物车／报价、10%交易状态机组织；交易中的详情读取单独计数，实际HTTP比例见报告。状态机交替取消订单和未发货付款／售后／退款。模拟模型故障与文档失败仅通过隔离网络假服务注入，不调用真实收费模型，不把预期任务失败算作正常交易5xx。

每一档分别统计P95／P99、错误、429和实际写请求量，备份窗口另行统计；核对容器内存峰值、重启、OOM及最终健康。只读验收器在显式读取事务中检查库存、预占、SKU与订单行投影、收退款次数和金额、归属以及原历史和幂等记录摘要。备份、文件副本和新路径恢复分别核验，不要求在线库与较早恢复点的文件字节相同。

实际结果和最终CI链接在本次验收结束后填写；未完成的运行不能计为通过。

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

## 发布及上线门槛

固定最终提交及镜像摘要；发布前一致备份并保留旧镜像，计划停机，重建后核对版本、健康、账号及业务摘要。若升级后已有新写入，先保留新库证据并评估前向修复，不直接恢复旧库。整个过程保留原业务卷、凭据及回滚材料，不清理其他项目。

本机恢复目标为RTO一小时；RPO24小时的整机故障结论必须在独立主机／介质接收完整备份文件对、目标端校验及恢复演练后才能成立。对外试用还需HTTPS、Secure Cookie、准确访问源、管理入口限制及实际告警接收人。真实营业另需支付回调验签、重复乱序处理、退款确认和渠道对账，本轮没有增加这些业务功能。
