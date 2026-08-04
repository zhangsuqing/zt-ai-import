# V4 重构假设说明

## 范围

本次只重构 V2 万能导入解析系统的下单主链路：

文件上传 -> 文件解析 -> 规则引擎 -> 数据校验 -> 批量落库 -> 任务进度追踪 -> 错误定位 -> 监控告警。

V3 审批、异常工单、品控暂扣、赔付审批和跨系统 Saga 不在本次实现范围。

## 架构选择

本实现选择数据库任务表 + Transactional Outbox + Worker Dispatch API 的事件驱动方案。

原因：

1. Vercel Serverless 不适合让用户上传请求阻塞等待 10,000 行完整处理。
2. 任务创建和 outbox 写入在同一个数据库事务中完成，可避免“任务创建成功但消息丢失”。
3. Worker 以批次为处理单元，支持失败重试、幂等跳过和行级错误追踪。
4. 在没有 Redis/Upstash 环境变量时，仍可通过 DB-backed outbox 满足可恢复任务系统；生产可将 `/api/import-worker/dispatch` 接入 Vercel Cron、QStash 或常驻 worker。

## 处理单元

默认批次大小为 1000 行，可通过 `IMPORT_BATCH_SIZE` 或提交参数调整。

10,000 行文件会拆成 10 个批次。每个批次有独立 `unit_id`，幂等键为 `task_id + unit_id`。

Worker 开始处理前会用 `status IN ('PENDING','QUEUED','FAILED') RETURNING id` 原子 claim 批次；claim 失败说明批次已经被其他 Worker 处理或已完成，当前消息直接跳过。完成批次时也只对未完成批次累计进度，避免重复投递导致重复入库或重复累计。

调度器每次执行前会恢复超过 `IMPORT_STALE_BATCH_MINUTES` 仍处于 `PROCESSING` 的批次，默认 10 分钟。恢复后批次状态改为 `FAILED` 并增加 `retry_count`，后续 Outbox 重试可继续处理。

## 批量处理

SKU 校验：

- 收集当前批次所有 SKU。
- 使用 `WHERE sku_code = ANY($1::text[])` 批量查询 `sku_master`。
- 不做逐行查询。

批量落库：

- 成功行使用 `jsonb_to_recordset` 批量 UPSERT 到 `orders`。
- 行级失败不阻断成功行入库。
- 最终状态根据失败行数聚合为 `COMPLETED` 或 `PARTIAL_SUCCESS`。

## 降级策略

当 SKU 主数据校验查询异常或超过 3 秒时，进入降级模式：

- 跳过完整 SKU 主数据校验。
- 仍记录每行 `W_SKU_VALIDATION_DEGRADED` 警告。
- 任务记录写入 `degraded=true` 和风险提示。
- 新任务在数据库恢复后自动回到正常校验。

## 可观测性

每个任务包含：

- `task_id`
- `trace_id`
- 批次 `unit_id`
- 行级错误 `import_task_errors`
- 批次耗时 `batch_performance_log`
- 时间线 `trace_events`
- 监控聚合 `/api/import-monitor/summary`

监控聚合包含近 5 分钟吞吐、Outbox 积压、队列告警、错误分布，以及解析/规则/校验/写入/总耗时的 P50/P95/P99。

运维可通过 `task_id`、`trace_id`、文件名、批次、行号范围或错误码定位到批次、行号、字段、脱敏原始值和错误原因。

## 敏感信息

错误明细中的手机号和地址会脱敏：

- 手机号保留前 3 位和后 2 位。
- 地址只保留前后少量字符。

数据库连接串、API Key 和队列连接串均通过环境变量配置，不写入源码。

## 重复上传策略

当前允许重复上传相同文件，每次生成新的 `task_id` 和 `trace_id`。业务幂等由运单行 `id` 和订单业务去重约束承担。生产增强可增加文件 hash 表，在相同用户、相同规则、相同 hash 的短时间窗口内提示复用已有任务。

## 容量推导

默认 1000 行/批，10 个批次。

每批主要操作：

- 1 次批量 SKU 查询。
- 1 次批量错误写入。
- 1 次批量订单 UPSERT。
- 1 次性能日志写入。
- 1 次任务聚合更新。

相比同步逐行查询和逐行 INSERT，数据库请求数量从万级下降到几十级。若生产接入 QStash/常驻 worker，可把 dispatcher 并发设置为 4-8，在数据库连接池可承受范围内扩展吞吐。

## 清理策略

- `sku_master` 压测数据通过 `npm run seed:v4` 幂等 UPSERT，不会重复增长。
- `orders`、`import_task_errors`、`batch_performance_log`、`trace_events` 和 `event_outbox` 可按保留周期归档；生产建议按月分区或按 `created_at` 定期归档到冷存储。
- `event_outbox` 中 `SENT` 事件保留 7-30 天用于排障，之后归档或删除；`FAILED` 事件保留更长周期用于审计。
- 错误和 Trace 日志只保留脱敏原始值。

## 自动化测试

`npm test` 使用 Node 内置测试脚本检查 V4 强制交付物、10000 行压测 Excel、Transactional Outbox、批量 SKU 查询、批量 UPSERT、幂等 claim、卡死恢复、监控聚合和 Trace 搜索能力。

## 待确认问题

1. 生产是否必须使用 Redis/BullMQ，还是 DB-backed outbox + Cron/QStash 可接受。
2. V2 运单表最终是否应由 `orders` 改名或映射为题目中的 `waybills`。
3. SKU 主数据字段是否需要对齐真实商品中心。
4. 降级任务是否需要后续自动补校验。
5. 任务和错误日志保留周期、归档策略和审计要求。
