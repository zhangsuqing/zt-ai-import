# ZT AI Import V2

V2 万能导入解析系统。V4 改造聚焦下单主链路：

文件上传 -> 文件解析 -> 规则引擎 -> 数据校验 -> 批量落库 -> 任务进度追踪 -> 错误定位 -> 监控告警。

## 本地启动

```bash
npm install
npm run dev
```

默认访问：

```text
http://127.0.0.1:3000
```

## 环境变量

```env
DATABASE_URL=postgresql://...
POSTGRES_URL=postgresql://...
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=...
LLM_MODEL=deepseek-v4-flash
IMPORT_BATCH_SIZE=1000
IMPORT_STALE_BATCH_MINUTES=10
```

数据库连接、API Key、队列连接串不得提交到 Git。

## V4 异步导入

核心 API：

- `POST /api/import-tasks` 创建导入任务，快速返回 `task_id`。
- `GET /api/import-tasks/:taskId` 查询进度。
- `GET /api/import-tasks/:taskId/errors` 查询行级错误。
- `GET /api/import-tasks/:taskId/batches` 查询批次和性能日志。
- `GET /api/traces/:traceId` 查询链路时间线。
- `GET /api/traces?task_id=&trace_id=&batch=&row_from=&row_to=&error_code=` 多条件检索链路。
- `GET /api/import-monitor/summary` 查询监控聚合。
- `POST /api/import-worker/dispatch?limit=4` 消费 Outbox 批次事件。

当前实现为 DB-backed Outbox + Dispatcher API，适配 Vercel Serverless。生产可用 Vercel Cron、QStash 或常驻 worker 周期调用 dispatcher。Dispatcher 会恢复超时 `PROCESSING` 批次，并通过批次原子 claim 避免重复消费重复累计。

## 压测数据

生成 20,000 条 SKU 主数据和 10,000 行 Excel：

```bash
npm run seed:v4
```

输出：

```text
test-data/10000-orders.xlsx
```

如果未配置数据库，脚本只生成 Excel；配置 `DATABASE_URL` 后会批量 UPSERT `sku_master`。

## 压测

基础验收：

```bash
npm test
npm run build
```

先启动服务，再执行：

```bash
npm run perf:v4
```

线上压测：

```bash
BASE_URL=https://zt-ai-import.vercel.app npm run perf:v4
```

## 文档

- `docs/v4-refactor-assumptions.md`
- `docs/v4-api.md`
- `docs/v4-performance-report.md`

## 正式运单查询

```text
GET /api/v1/waybills?waybillNo=LOAD_000001
GET /api/v1/waybills?keyword=LOAD
```
