# V4 压测报告

## 当前验证结果

当前工作区未配置 `DATABASE_URL/POSTGRES_URL`，因此已完成：

- TypeScript 验证：`npx tsc --noEmit` 通过。
- 生产构建验证：`npm run build` 通过。
- 自动化静态验收：`npm test` 通过。
- 压测数据脚本语法验证：通过。
- 10,000 行 Excel 生成：`test-data/10000-orders.xlsx`。

数据库灌入和端到端 60 秒压测需在配置 PostgreSQL 环境变量后执行。

## 执行命令

```bash
npm run seed:v4
npm test
npm run dev
npm run perf:v4
```

可选参数：

```bash
BASE_URL=https://zt-ai-import.vercel.app npm run perf:v4
BATCH_SIZE=1000 DISPATCH_LIMIT=8 npm run perf:v4
```

## 指标口径

- 上传耗时：`POST /api/import-tasks` 返回 `task_id` 的耗时。
- 总耗时：任务创建后到 `COMPLETED/PARTIAL_SUCCESS/FAILED` 的耗时。
- 成功行：批量 UPSERT 到 `orders` 的行。
- 失败行：写入 `import_task_errors` 且错误码不是降级警告的行。
- HTTP 错误：压测轮询和调度过程中的非 2xx。
- 队列积压：`event_outbox.status = PENDING` 的事件数量。
- 阶段耗时：`batch_performance_log` 中 parse/rule/validate/insert/total 的 P50/P95/P99。

## 目标

- 上传接口 P95 <= 1 秒。
- 10,000 行全链路 <= 60 秒。
- 不出现 500/504。
- 少量非法 SKU 应被定位到具体行、字段和错误码。

## 已知瓶颈

DB-backed outbox 在 Vercel 上适合考试演示和中等吞吐；如果目标提升到 50,000 行/分钟，优先改为 QStash/BullMQ + 常驻 worker，并评估 PostgreSQL 批量 UPSERT 是否成为主瓶颈。

当前报告尚未包含真实 PostgreSQL 环境下的 10,000 行总耗时、上传接口 P95、连接池截图或监控看板截图。正式提交前必须补充这些实测数据，否则不能作为 60 秒达标证明。
