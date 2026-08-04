# V4 API 文档

## 创建导入任务

`POST /api/import-tasks`

请求体：

```json
{
  "file": { "fileName": "10000-orders.xlsx", "fileType": "excel", "sheets": [], "text": "" },
  "rule": { "id": "rule-id" },
  "batchSize": 1000
}
```

响应：

```json
{
  "task_id": "task_xxx",
  "trace_id": "trace_xxx",
  "status": "PENDING",
  "total_rows": 10000,
  "total_batches": 10,
  "upload_duration_ms": 328
}
```

## 查询任务进度

`GET /api/import-tasks/:taskId`

返回任务进度、批次列表和最近 10 条错误。

## 查询错误明细

`GET /api/import-tasks/:taskId/errors?batch=1&error_code=E_SKU_NOT_FOUND&page=1&page_size=50`

字段包含批次、行号、字段、脱敏原始值、错误码、错误原因和 traceId。

## 查询批次性能

`GET /api/import-tasks/:taskId/batches`

返回批次状态和 `parse/rule/validate/insert/total` 耗时。

## Trace 查询

`GET /api/traces/:traceId`

按时间线返回 API、Outbox、Worker、DB 写入相关事件。

也支持带筛选参数：

```text
GET /api/traces/:traceId?task_id=task_xxx&batch=4&row_from=100&row_to=200&error_code=E_SKU_NOT_FOUND
GET /api/traces?trace_id=trace_xxx&task_id=task_xxx&file_name=10000&batch=4&error_code=E_SKU_NOT_FOUND
```

用于按 `task_id`、`trace_id`、文件名、批次号、行号范围和错误码定位失败节点。

## 监控聚合

`GET /api/import-monitor/summary`

返回任务状态分布、Outbox 积压、队列告警、近 5 分钟吞吐、错误码分布、最近批次性能，以及解析/规则/校验/写入/总耗时的 P50/P95/P99。

## Dispatcher

`POST /api/import-worker/dispatch?limit=4`

消费待投递 outbox 事件。每次调度会先恢复超时 `PROCESSING` 批次，再原子 claim 待处理批次。生产建议由 Vercel Cron、QStash 或常驻 worker 调用；演示环境由前端轮询主动推进。

## V2 正式运单查询接口

`GET /api/v1/waybills?waybillNo=LOAD_000001`

用于外部系统查询 V2 已导入运单，返回按外部编码聚合后的运单和 SKU 明细。
