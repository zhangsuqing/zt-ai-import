"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  ClipboardList,
  Database,
  FileInput,
  FileSpreadsheet,
  FolderPlus,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Trash2,
  UploadCloud
} from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { extractFile } from "@/lib/client-file";
import { normalizeParseRule, parseWithRule, validateRows } from "@/lib/rule-engine";
import { CanonicalField, ExtractedFile, OrderRow, ParseRule, ValidationError, emptyOrderRow, fieldLabels } from "@/lib/types";

const editableFields: CanonicalField[] = [
  "externalCode",
  "storeName",
  "receiverName",
  "receiverPhone",
  "receiverAddress",
  "skuCode",
  "skuName",
  "quantity",
  "skuSpec",
  "temperature",
  "remark"
];

type ImportTaskView = {
  task_id: string;
  trace_id: string;
  status: string;
  total_rows: number;
  processed_rows: number;
  success_rows: number;
  failed_rows: number;
  total_batches: number;
  completed_batches: number;
  degraded: boolean;
  warning?: string;
  progress: number;
  recent_errors?: Array<{
    rowNumber: number;
    fieldName: string;
    rawValue: string;
    errorCode: string;
    errorReason: string;
    batchIndex: number;
  }>;
  batches?: Array<{
    unitId: string;
    batchIndex: number;
    startRow: number;
    endRow: number;
    status: string;
    retryCount: number;
  }>;
};

type MonitorSummary = {
  pendingEvents?: number;
  queueAlert?: string;
  throughputRowsPerMinute?: number;
  taskStatus?: Array<{ status: string; count: number }>;
  errorCounts?: Array<{ error_code: string; count: number }>;
  stageStats?: Record<string, { p50: number; p95: number; p99: number }>;
};

const makeManualRule = (): ParseRule => ({
  id: crypto.randomUUID(),
  name: "新建表格规则",
  description: "手动配置字段映射后保存。",
  sourceKind: "table",
  sheetMode: "all",
  headerRow: 1,
  dataStartRow: 2,
  groupBy: "externalCode",
  mappings: [],
  skipPatterns: ["合计", "总计"],
  createdBy: "manual",
  updatedAt: new Date().toISOString()
});

type HistoryOrder = { externalCode: string; first: OrderRow; items: OrderRow[]; totalQuantity: number };

function groupOrders(rows: OrderRow[]): HistoryOrder[] {
  const groups = new Map<string, OrderRow[]>();
  for (const row of rows) {
    const key = row.externalCode || row.id;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return Array.from(groups.entries()).map(([externalCode, items]) => ({
    externalCode,
    first: items[0],
    items,
    totalQuantity: items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
  }));
}

export default function Page() {
  const [activeSection, setActiveSection] = useState<"import" | "tasks" | "monitor">("import");
  const [file, setFile] = useState<ExtractedFile | null>(null);
  const [rules, setRules] = useState<ParseRule[]>([]);
  const [activeRule, setActiveRule] = useState<ParseRule | null>(null);
  const [ruleDraft, setRuleDraft] = useState("");
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [previewPage, setPreviewPage] = useState(1);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [history, setHistory] = useState<OrderRow[]>([]);
  const [historyOrders, setHistoryOrders] = useState<HistoryOrder[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [keyword, setKeyword] = useState("");
  const [historyPage, setHistoryPage] = useState(1);
  const [expandedHistoryCodes, setExpandedHistoryCodes] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [taskAction, setTaskAction] = useState("");
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [loadingMonitor, setLoadingMonitor] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTask, setCurrentTask] = useState<ImportTaskView | null>(null);
  const [taskList, setTaskList] = useState<Array<{ id: string; traceId: string; status: string; totalRows: number; processedRows: number; failedRows: number }>>([]);
  const [monitor, setMonitor] = useState<MonitorSummary | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const taskPrefetchedRef = useRef(false);
  const taskRequestRef = useRef<Promise<number> | null>(null);
  const monitorPrefetchedRef = useRef(false);
  const historyPrefetchedRef = useRef(false);

  useEffect(() => {
    void refreshRules();
    const taskTimer = window.setTimeout(() => {
      void refreshImportTasks(false);
    }, 800);
    const monitorTimer = window.setTimeout(() => {
      void refreshMonitor(false);
    }, 1400);
    const historyTimer = window.setTimeout(() => {
      void refreshHistory("", 1, false);
    }, 1800);
    return () => {
      window.clearTimeout(taskTimer);
      window.clearTimeout(monitorTimer);
      window.clearTimeout(historyTimer);
    };
  }, []);
  useEffect(() => {
    if (activeSection === "tasks") {
      if (!taskPrefetchedRef.current) void refreshImportTasks();
      return;
    }
    if (activeSection === "monitor") {
      void refreshMonitor();
      void refreshHistory(keyword, 1);
    }
  }, [activeSection]);

  useEffect(() => {
    setErrors(validateRows(rows, history.map((row) => row.externalCode)));
  }, [rows, history]);

  useEffect(() => {
    if (!currentTask || currentTask.status === "CREATING" || ["COMPLETED", "PARTIAL_SUCCESS", "FAILED"].includes(currentTask.status)) return;
    const timer = window.setInterval(() => {
      void pumpImportQueue();
      void refreshTask(currentTask.task_id);
      void refreshMonitor();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [currentTask]);

  const errorMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const error of errors) {
      const set = map.get(error.rowId) ?? new Set<string>();
      set.add(error.field);
      map.set(error.rowId, set);
    }
    return map;
  }, [errors]);

  async function refreshRules() {
    const res = await fetch("/api/rules");
    const data = await res.json();
    setRules(data.rules ?? []);
  }

  async function refreshHistory(search = keyword, page = 1, showLoading = true) {
    try {
      if (showLoading) setLoadingHistory(true);
      const res = await fetch(`/api/orders?mode=groups&keyword=${encodeURIComponent(search)}&page=${page}&pageSize=10`);
      const data = await res.json();
      const groups = (data.groups ?? []) as HistoryOrder[];
      setHistoryOrders(groups);
      setHistory(groups.flatMap((group) => group.items));
      setHistoryTotal(Number(data.total ?? groups.length));
      setHistoryPage(Number(data.page ?? page));
      if (!search && page === 1) historyPrefetchedRef.current = true;
    } finally {
      if (showLoading) setLoadingHistory(false);
    }
  }

  async function refreshImportTasks(showLoading = true) {
    if (taskRequestRef.current) return taskRequestRef.current;
    const request = (async () => {
      try {
        if (showLoading) setLoadingTasks(true);
        const res = await fetch("/api/import-tasks");
        const data = await res.json();
        const nextTasks = (data.tasks ?? []).map((task: any) => ({
          id: task.id,
          traceId: task.traceId,
          status: task.status,
          totalRows: task.totalRows,
          processedRows: task.processedRows,
          failedRows: task.failedRows
        }));
        setTaskList(nextTasks);
        taskPrefetchedRef.current = true;
        return nextTasks.length;
      } finally {
        if (showLoading) setLoadingTasks(false);
        taskRequestRef.current = null;
      }
    })();
    taskRequestRef.current = request;
    return request;
  }

  async function refreshMonitor(showLoading = true) {
    try {
      if (showLoading) setLoadingMonitor(true);
      const res = await fetch("/api/import-monitor/summary");
      if (res.ok) {
        setMonitor(await res.json());
        monitorPrefetchedRef.current = true;
      }
    } finally {
      if (showLoading) setLoadingMonitor(false);
    }
  }

  async function pumpImportQueue() {
    const res = await fetch("/api/import-worker/dispatch?limit=4", { method: "POST" });
    if (!res.ok) throw new Error("推进队列失败");
    return await res.json() as { recovered?: number; claimed?: number; results?: unknown[] };
  }

  async function refreshTask(taskId: string) {
    const res = await fetch(`/api/import-tasks/${encodeURIComponent(taskId)}`);
    if (!res.ok) return;
    const data = await res.json() as ImportTaskView;
    setCurrentTask(data);
    if (["COMPLETED", "PARTIAL_SUCCESS", "FAILED"].includes(data.status)) {
      if (activeSection === "monitor") await refreshHistory(keyword, historyPage);
      await refreshImportTasks();
    }
  }

  async function handlePumpQueue() {
    try {
      setTaskAction("pump");
      const result = await pumpImportQueue();
      if (currentTask) await refreshTask(currentTask.task_id);
      await refreshImportTasks();
      await refreshMonitor();
      const claimed = result.claimed ?? 0;
      const recovered = result.recovered ?? 0;
      toast.success(claimed || recovered ? `队列已推进：处理 ${claimed} 个事件，恢复 ${recovered} 个批次` : "队列已检查：暂无待处理事件");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "推进队列失败");
    } finally {
      setTaskAction("");
    }
  }

  async function handleRefreshTasks() {
    try {
      setTaskAction("refresh");
      const count = await refreshImportTasks();
      if (currentTask) await refreshTask(currentTask.task_id);
      await refreshMonitor();
      toast.success(`任务已刷新：${count} 条`);
    } catch {
      toast.error("刷新任务失败");
    } finally {
      setTaskAction("");
    }
  }

  async function handleOpenTask(taskId: string) {
    try {
      setTaskAction(`open:${taskId}`);
      await refreshTask(taskId);
      await refreshMonitor();
      toast.success(`已打开任务：${taskId}`);
    } catch {
      toast.error("打开任务失败");
    } finally {
      setTaskAction("");
    }
  }

  async function handleFiles(files: FileList | null) {
    const selected = files?.[0];
    if (!selected) return;
    try {
      setBusy("读取文件");
      setProgress(15);
      const extracted = await extractFile(selected);
      setFile(extracted);
      setRows([]);
      setPreviewPage(1);
      setSelectedRowIds(new Set());
      setProgress(45);
      if (activeRule) {
        const normalized = normalizeParseRule(activeRule, extracted);
        setActiveRule(normalized);
        setRuleDraft(JSON.stringify(normalized, null, 2));
        toast.success("文件读取完成，已沿用当前规则");
      } else {
        await generateRule(extracted);
        toast.success("文件读取完成");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "文件读取失败");
    } finally {
      setBusy("");
      setProgress(0);
    }
  }


  async function generateRule(targetFile = file) {
    if (!targetFile) return toast.error("请先上传文件");
    try {
      setBusy("AI 生成规则");
      const res = await fetch("/api/ai-rule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: targetFile })
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok || !data?.rule) {
        throw new Error(data?.error ?? `AI 生成规则失败：HTTP ${res.status}`);
      }
      setActiveRule(data.rule);
      setRuleDraft(JSON.stringify(data.rule, null, 2));
      toast.success(data.note ?? "规则已生成");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "AI 生成规则失败");
    } finally {
      setBusy("");
    }
  }


  async function saveRule() {
    try {
      const parsed = normalizeParseRule(JSON.parse(ruleDraft) as Partial<ParseRule>, file ?? undefined);
      const res = await fetch("/api/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed)
      });
      const data = await res.json();
      setActiveRule(data.rule);
      setRuleDraft(JSON.stringify(data.rule, null, 2));
      await refreshRules();
      toast.success("规则已保存");
    } catch {
      toast.error("规则 JSON 格式不正确");
    }
  }

  function useRule(rule: ParseRule) {
    const normalized = normalizeParseRule(rule, file ?? undefined);
    setActiveRule(normalized);
    setRuleDraft(JSON.stringify(normalized, null, 2));
  }

  async function deleteRule(rule: ParseRule) {
    await fetch(`/api/rules?id=${encodeURIComponent(rule.id)}`, { method: "DELETE" });
    if (activeRule?.id === rule.id) {
      setActiveRule(null);
      setRuleDraft("");
    }
    await refreshRules();
    toast.success("规则已删除");
  }

  function executeParse() {
    if (!file) return toast.error("请先上传文件");
    let rule: ParseRule;
    try {
      rule = normalizeParseRule(JSON.parse(ruleDraft) as Partial<ParseRule>, file);
    } catch {
      toast.error("规则 JSON 格式不正确，无法解析");
      return;
    }
    try {
      setRuleDraft(JSON.stringify(rule, null, 2));
      const parsed = parseWithRule(file, rule);
      setRows(parsed);
      setPreviewPage(1);
      setSelectedRowIds(new Set());
      toast.success(`试解析完成 ${parsed.length} 行`);
    } catch (error) {
      toast.error(error instanceof Error ? `规则执行失败：${error.message}` : "规则执行失败");
    }
  }

  function updateCell(rowId: string, field: CanonicalField, value: string) {
    setRows((current) => current.map((row) => (row.id === rowId ? { ...row, [field]: value } : row)));
  }

  function toggleRowSelection(rowId: string, checked: boolean) {
    setSelectedRowIds((current) => {
      const next = new Set(current);
      if (checked) next.add(rowId);
      else next.delete(rowId);
      return next;
    });
  }

  function toggleVisibleRowsSelection(visibleRows: OrderRow[], checked: boolean) {
    setSelectedRowIds((current) => {
      const next = new Set(current);
      for (const row of visibleRows) {
        if (checked) next.add(row.id);
        else next.delete(row.id);
      }
      return next;
    });
  }

  function deleteSelectedRows() {
    setRows((current) => current.filter((row) => !selectedRowIds.has(row.id)));
    setSelectedRowIds(new Set());
    setPreviewPage(1);
  }

  function exportExcel() {
    const data = rows.map((row) => Object.fromEntries(editableFields.map((field) => [fieldLabels[field], row[field]])));
    const sheet = XLSX.utils.json_to_sheet(data);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "预览数据");
    XLSX.writeFile(book, "智能导入预览.xlsx");
  }

  async function submitOrders() {
    if (errors.length) return toast.error("存在校验错误，请先修正");
    if (!rows.length) return toast.error("没有可提交的数据");
    if (!file) return toast.error("请先上传文件");
    let rule: ParseRule;
    try {
      rule = normalizeParseRule(JSON.parse(ruleDraft) as Partial<ParseRule>, file);
    } catch {
      return toast.error("规则 JSON 格式不正确");
    }
    let loadingToast: string | number | undefined;
    try {
      setBusy("创建异步导入任务");
      loadingToast = toast.loading("正在创建异步导入任务...");
      setCurrentTask({
        task_id: "creating",
        trace_id: "",
        status: "CREATING",
        total_rows: rows.length,
        processed_rows: 0,
        success_rows: 0,
        failed_rows: 0,
        total_batches: Math.max(1, Math.ceil(rows.length / 1000)),
        completed_batches: 0,
        degraded: false,
        progress: 0
      });
      setRows([]);
      setSelectedRowIds(new Set());
      setPreviewPage(1);
      setActiveSection("tasks");
      const res = await fetch("/api/import-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.fileName, rule, rows, batchSize: 1000 })
      });
      const data = await res.json();
      if (!res.ok) {
        setCurrentTask(null);
        setActiveSection("import");
        return toast.error(data.error ?? "创建任务失败");
      }
      toast.success(`任务已创建：${data.task_id}`);
      setCurrentTask({
        task_id: data.task_id,
        trace_id: data.trace_id,
        status: data.status,
        total_rows: data.total_rows,
        processed_rows: 0,
        success_rows: 0,
        failed_rows: 0,
        total_batches: data.total_batches,
        completed_batches: 0,
        degraded: false,
        progress: 0
      });
      setTaskList((current) => [
        {
          id: data.task_id,
          traceId: data.trace_id,
          status: data.status,
          totalRows: data.total_rows,
          processedRows: 0,
          failedRows: 0
        },
        ...current.filter((task) => task.id !== data.task_id)
      ]);
      taskPrefetchedRef.current = true;
      setActiveSection("tasks");
      void (async () => {
        try {
          await pumpImportQueue();
          await refreshTask(data.task_id);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "推进队列失败");
        }
      })();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建任务失败");
    } finally {
      if (loadingToast) toast.dismiss(loadingToast);
      setBusy("");
    }
  }

  const historyPageSize = 10;
  const totalHistoryPages = Math.max(1, Math.ceil(historyTotal / historyPageSize));
  const currentHistoryPage = Math.min(historyPage, totalHistoryPages);
  const pagedHistoryOrders = historyOrders;
  const previewPageSize = 50;
  const totalPreviewPages = Math.max(1, Math.ceil(rows.length / previewPageSize));
  const currentPreviewPage = Math.min(previewPage, totalPreviewPages);
  const visibleRows = rows.slice((currentPreviewPage - 1) * previewPageSize, currentPreviewPage * previewPageSize);
  const visibleRowStart = (currentPreviewPage - 1) * previewPageSize;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">ZT</div>
          <div>
            <div className="brand-title">中通冷链</div>
            <div className="brand-sub">V2 Async Import</div>
          </div>
        </div>
        <button className={`nav-item ${activeSection === "import" ? "active" : ""}`} onClick={() => setActiveSection("import")}><UploadCloud size={16} />万能导入解析</button>
        <button className={`nav-item ${activeSection === "tasks" ? "active" : ""}`} onClick={() => setActiveSection("tasks")}><Activity size={16} />任务追踪</button>
        <button className={`nav-item ${activeSection === "monitor" ? "active" : ""}`} onClick={() => setActiveSection("monitor")}><Database size={16} />监控告警</button>
      </aside>

      <main className="main">
        <header className="topbar">
          <strong>V2 万能导入解析系统</strong>
          <span>异步事件驱动 / Outbox / 批量校验 / 批量落库 / Trace 可观测</span>
        </header>

        <section className="content">
          {activeSection === "import" && <div className="grid-2">
            <div className="panel rule-editor">
              <div className="upload-card">
                <div className="upload-title">文件上传</div>
                <button
                  type="button"
                  className="upload-zone"
                  onClick={() => inputRef.current?.click()}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => { event.preventDefault(); void handleFiles(event.dataTransfer.files); }}
                >
                  <FolderPlus className="upload-folder" size={92} strokeWidth={1.7} />
                  <strong>点击或拖拽文件</strong>
                  <span>支持格式: .xls,.xlsx</span>
                  {file && <em>当前文件: {file.fileName}</em>}
                </button>
                <input ref={inputRef} hidden type="file" accept=".xlsx,.xls" onChange={(event) => void handleFiles(event.target.files)} />
                {progress > 0 && <div className="progress"><span style={{ width: `${progress}%` }} /></div>}
              </div>
              <div className="toolbar rule-actions" style={{ paddingInline: 0 }}>
                <button className="btn soft" onClick={() => void generateRule()} disabled={!file || Boolean(busy)}>{busy.includes("AI") ? <Loader2 size={15} className="spin" /> : <FileInput size={15} />}AI 生成规则</button>
                <button className="btn" onClick={() => useRule(makeManualRule())}><Plus size={15} />新建规则</button>
                <button className="btn primary" onClick={saveRule}><Save size={15} />保存规则</button>
                <button className="btn primary" onClick={executeParse}><CheckCircle2 size={15} />试解析</button>
              </div>
              <textarea className="textarea" value={ruleDraft} onChange={(event) => setRuleDraft(event.target.value)} placeholder="上传文件后生成或手动填写解析规则 JSON" />
            </div>

            <div className="panel rule-editor">
              <div className="toolbar" style={{ paddingInline: 0, paddingTop: 0 }}>
                <strong>解析规则库</strong>
                <span className="muted">上传时手动选择规则，不自动匹配。</span>
              </div>
              {rules.length === 0 && <div className="empty">暂无已保存规则</div>}
              {rules.map((rule) => (
                <div className={`rule-card ${activeRule?.id === rule.id ? "active" : ""}`} key={rule.id} onClick={() => useRule(rule)}>
                  <strong>{rule.name}</strong>
                  <div className="muted">{rule.description}</div>
                  <div className="muted">类型：{rule.sourceKind} / Sheet：{rule.sheetMode} / 映射：{rule.mappings.length}</div>
                  <button className="link-btn danger-text" onClick={(event) => { event.stopPropagation(); void deleteRule(rule); }}>删除</button>
                </div>
              ))}
            </div>
          </div>}

          {activeSection === "import" && <div className="panel">
            <div className="toolbar">
              <div className="toolbar-group">
                <button className="btn primary" onClick={() => { setRows((current) => [emptyOrderRow(), ...current]); setSelectedRowIds(new Set()); setPreviewPage(1); }}><Plus size={15} />新增</button>
                <button className="btn danger" onClick={deleteSelectedRows} disabled={!selectedRowIds.size}><Trash2 size={15} />删除选中</button>
                <button className="btn soft" onClick={exportExcel} disabled={!rows.length}><ArrowDownToLine size={15} />导出 Excel</button>
                <button className="btn primary" onClick={submitOrders} disabled={Boolean(busy) || errors.length > 0 || rows.length === 0}>{busy === "创建异步导入任务" ? <Loader2 size={15} className="spin" /> : <Send size={15} />}{busy === "创建异步导入任务" ? "提交中" : "异步提交下单"}</button>
              </div>
              <div className="toolbar-group">
                <span className={`status-pill ${errors.length ? "bad" : "ok"}`}>{errors.length ? `${errors.length} 个错误` : "本地校验通过"}</span>
                <span className="muted">已选 {selectedRowIds.size} 行</span>
                <span className="muted">共 {rows.length} 行</span>
              </div>
            </div>
            <EditableTable rows={visibleRows} rowOffset={visibleRowStart} selectedRowIds={selectedRowIds} errors={errorMap} onChange={updateCell} onToggleRow={toggleRowSelection} onToggleAll={toggleVisibleRowsSelection} />
            {rows.length > 0 && <div className="pagination-bar"><button className="btn" disabled={currentPreviewPage <= 1} onClick={() => setPreviewPage((page) => Math.max(1, page - 1))}>上一页</button><span className="muted">第 {currentPreviewPage} / {totalPreviewPages} 页，共 {rows.length} 行</span><button className="btn" disabled={currentPreviewPage >= totalPreviewPages} onClick={() => setPreviewPage((page) => Math.min(totalPreviewPages, page + 1))}>下一页</button></div>}
            {errors.length > 0 && <div className="error-list">{errors.slice(0, 100).map((error, index) => <div key={`${error.rowId}-${index}`}>第 {error.rowNumber} 行 / {error.field === "row" ? "整行" : fieldLabels[error.field]}：{error.message}</div>)}</div>}
          </div>}

          {activeSection === "tasks" && <div className="grid-2">
            <div className="panel">
              <div className="toolbar">
                <div className="toolbar-group"><Activity size={16} /><strong>任务进度追踪</strong><span className="muted">轮询状态并推进 outbox 消费。</span></div>
                <div className="toolbar-group">
                  <button className="btn" onClick={() => void handlePumpQueue()} disabled={Boolean(taskAction)}>{taskAction === "pump" ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}推进队列</button>
                  <button className="btn" onClick={() => void handleRefreshTasks()} disabled={Boolean(taskAction)}>{taskAction === "refresh" ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}刷新任务</button>
                </div>
              </div>
              {loadingTasks && <div className="inline-loading"><Loader2 size={15} className="spin" />正在加载任务</div>}
              <TaskProgress task={currentTask} />
            </div>

            <div className="panel">
              <div className="toolbar"><Database size={16} /><strong>监控告警</strong><span className="muted">队列积压、错误分布、任务状态。</span></div>
              {loadingMonitor && <div className="inline-loading"><Loader2 size={15} className="spin" />正在加载监控</div>}
              <MonitorPanel monitor={monitor} />
            </div>
          </div>}

          {activeSection === "tasks" && <div className="panel">
            <div className="toolbar">
              <div className="toolbar-group"><ClipboardList size={16} /><strong>最近任务</strong></div>
            </div>
            {loadingTasks && <div className="inline-loading"><Loader2 size={15} className="spin" />正在加载任务</div>}
            <TaskList tasks={taskList} activeTaskId={currentTask?.task_id} loadingTaskId={taskAction.startsWith("open:") ? taskAction.slice(5) : undefined} onOpen={(taskId) => void handleOpenTask(taskId)} />
          </div>}

          {activeSection === "monitor" && <div className="grid-2">
            <div className="panel">
              <div className="toolbar"><Database size={16} /><strong>监控告警</strong><span className="muted">吞吐、积压、阶段耗时和错误分布。</span></div>
              {loadingMonitor && <div className="inline-loading"><Loader2 size={15} className="spin" />正在加载监控</div>}
              <MonitorPanel monitor={monitor} />
            </div>
            <div className="panel">
              <div className="toolbar">
                <div className="toolbar-group"><ClipboardList size={16} /><strong>最近任务</strong></div>
                <button className="btn" onClick={() => void handleRefreshTasks()} disabled={Boolean(taskAction)}>{taskAction === "refresh" ? <Loader2 size={15} className="spin" /> : null}<RefreshCw size={15} />刷新</button>
              </div>
              <TaskList tasks={taskList} activeTaskId={currentTask?.task_id} loadingTaskId={taskAction.startsWith("open:") ? taskAction.slice(5) : undefined} onOpen={(taskId) => { setActiveSection("tasks"); void handleOpenTask(taskId); }} />
            </div>
          </div>}

          {activeSection === "monitor" && <div className="panel history">
            <div className="toolbar">
              <div className="toolbar-group"><FileSpreadsheet size={16} /><strong>已导入运单列表</strong><span className="muted">服务端读取，按外部编码聚合。</span></div>
              <div className="toolbar-group">
                <input className="input" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="外部编码/姓名/门店" />
                <button className="btn primary" onClick={() => void refreshHistory(keyword, 1)} disabled={loadingHistory}>{loadingHistory ? <Loader2 size={15} className="spin" /> : <Search size={15} />}查询</button>
              </div>
            </div>
            {loadingHistory && <div className="inline-loading"><Loader2 size={15} className="spin" />正在加载运单</div>}
            <HistoryTable orders={pagedHistoryOrders} expandedCodes={expandedHistoryCodes} onToggle={(externalCode) => setExpandedHistoryCodes((current) => { const next = new Set(current); if (next.has(externalCode)) next.delete(externalCode); else next.add(externalCode); return next; })} />
            <div className="pagination-bar"><button className="btn" disabled={currentHistoryPage <= 1} onClick={() => void refreshHistory(keyword, Math.max(1, currentHistoryPage - 1))}>上一页</button><span className="muted">第 {currentHistoryPage} / {totalHistoryPages} 页，共 {historyTotal} 条</span><button className="btn" disabled={currentHistoryPage >= totalHistoryPages} onClick={() => void refreshHistory(keyword, Math.min(totalHistoryPages, currentHistoryPage + 1))}>下一页</button></div>
          </div>}
        </section>
      </main>
    </div>
  );
}

function EditableTable({
  rows,
  rowOffset,
  selectedRowIds,
  errors,
  onChange,
  onToggleRow,
  onToggleAll
}: {
  rows: OrderRow[];
  rowOffset: number;
  selectedRowIds: Set<string>;
  errors: Map<string, Set<string>>;
  onChange: (rowId: string, field: CanonicalField, value: string) => void;
  onToggleRow: (rowId: string, checked: boolean) => void;
  onToggleAll: (rows: OrderRow[], checked: boolean) => void;
}) {
  if (!rows.length) return <div className="empty">上传文件并试解析后，结构化订单会显示在这里。</div>;
  const allSelected = rows.length > 0 && rows.every((row) => selectedRowIds.has(row.id));
  const someSelected = rows.some((row) => selectedRowIds.has(row.id));
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="select-col">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(input) => {
                  if (input) input.indeterminate = someSelected && !allSelected;
                }}
                onChange={(event) => onToggleAll(rows, event.currentTarget.checked)}
                aria-label="选择当前显示行"
              />
            </th>
            <th>序号</th>
            {editableFields.map((field) => <th key={field}>{fieldLabels[field]}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const rowErrors = errors.get(row.id);
            return (
              <tr key={row.id} className={rowErrors?.size ? "error-row" : ""}>
                <td className="select-col">
                  <input
                    type="checkbox"
                    checked={selectedRowIds.has(row.id)}
                    onChange={(event) => onToggleRow(row.id, event.currentTarget.checked)}
                    aria-label={`选择第 ${index + 1} 行`}
                  />
                </td>
                <td>{rowOffset + index + 1}</td>
                {editableFields.map((field) => (
                  <td key={field} className={rowErrors?.has(field) || rowErrors?.has("row") ? "error-cell" : ""}>
                    <input value={String(row[field] ?? "")} onChange={(event) => onChange(row.id, field, event.target.value)} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TaskProgress({ task }: { task: ImportTaskView | null }) {
  if (!task) return <div className="empty">暂无任务。点击“异步提交下单”后会创建任务。</div>;
  return (
    <div style={{ padding: "12px 16px" }}>
      <div className="toolbar" style={{ paddingInline: 0 }}>
        <span className={`status-pill ${task.failed_rows ? "bad" : "ok"}`}>{task.status}</span>
        <span className="muted">task_id: {task.task_id}</span>
        <span className="muted">trace_id: {task.trace_id}</span>
      </div>
      <div className="progress"><span style={{ width: `${task.progress}%` }} /></div>
      <div className="toolbar" style={{ paddingInline: 0 }}>
        <span>进度 {task.processed_rows}/{task.total_rows}</span>
        <span>成功 {task.success_rows}</span>
        <span>失败 {task.failed_rows}</span>
        <span>批次 {task.completed_batches}/{task.total_batches}</span>
      </div>
      {(task.degraded || task.warning) && <div className="notice danger"><AlertTriangle size={16} />{task.warning ?? "SKU 校验已降级，本次导入需后续复核。"}</div>}
      {task.recent_errors?.length ? <div className="error-list">{task.recent_errors.map((error, index) => <div key={index}>批次 {error.batchIndex} / 第 {error.rowNumber} 行 / {error.fieldName} / {error.errorCode}：{error.errorReason}，原始值：{error.rawValue}</div>)}</div> : <div className="muted">暂无行级错误。</div>}
      {task.batches?.length ? (
        <div className="table-wrap" style={{ maxHeight: 260, marginTop: 12 }}>
          <table>
            <thead><tr><th>批次</th><th>unit_id</th><th>行范围</th><th>状态</th><th>重试</th></tr></thead>
            <tbody>{task.batches.map((batch) => <tr key={batch.unitId}><td>{batch.batchIndex}</td><td>{batch.unitId}</td><td>{batch.startRow}-{batch.endRow}</td><td>{batch.status}</td><td>{batch.retryCount}</td></tr>)}</tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function TaskList({
  tasks,
  activeTaskId,
  loadingTaskId,
  onOpen
}: {
  tasks: Array<{ id: string; traceId: string; status: string; totalRows: number; processedRows: number; failedRows: number }>;
  activeTaskId?: string;
  loadingTaskId?: string;
  onOpen: (taskId: string) => void;
}) {
  if (!tasks.length) return <div className="empty">暂无任务记录。</div>;
  return (
    <div className="table-wrap" style={{ maxHeight: 260 }}>
      <table>
        <thead><tr><th>task_id</th><th>trace_id</th><th>状态</th><th>进度</th><th>失败行</th><th>操作</th></tr></thead>
        <tbody>{tasks.map((task) => <tr key={task.id} className={activeTaskId === task.id ? "active-row" : ""}><td>{task.id}</td><td>{task.traceId}</td><td>{task.status}</td><td>{task.processedRows}/{task.totalRows}</td><td>{task.failedRows}</td><td><button className="link-btn" onClick={() => onOpen(task.id)} disabled={loadingTaskId === task.id}>{loadingTaskId === task.id ? "加载中" : "查看"}</button></td></tr>)}</tbody>
      </table>
    </div>
  );
}

function MonitorPanel({ monitor }: { monitor: MonitorSummary | null }) {
  if (!monitor) return <div className="empty">暂无监控数据。</div>;
  return (
    <div style={{ padding: "12px 16px" }}>
      <div className="metric-grid">
        <div className="mini-card"><strong>{Math.round(monitor.throughputRowsPerMinute ?? 0)}</strong><span>近 5 分钟行/分钟</span></div>
        <div className="mini-card"><strong>{monitor.pendingEvents ?? 0}</strong><span>Outbox 待投递</span></div>
        <div className="mini-card"><strong>{monitor.taskStatus?.reduce((sum, item) => sum + Number(item.count), 0) ?? 0}</strong><span>任务总数</span></div>
        <div className="mini-card"><strong>{monitor.queueAlert ?? "OK"}</strong><span>队列告警</span></div>
      </div>
      {monitor.stageStats ? (
        <>
          <div className="muted" style={{ marginTop: 10 }}>阶段耗时 P50 / P95 / P99 ms</div>
          <div className="table-wrap" style={{ maxHeight: 220, marginTop: 8 }}>
            <table>
              <thead><tr><th>阶段</th><th>P50</th><th>P95</th><th>P99</th></tr></thead>
              <tbody>
                {Object.entries(monitor.stageStats).map(([stage, stat]) => (
                  <tr key={stage}><td>{stage}</td><td>{stat.p50}</td><td>{stat.p95}</td><td>{stat.p99}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      <div className="muted" style={{ marginTop: 10 }}>错误分布</div>
      {(monitor.errorCounts ?? []).map((item) => <div key={item.error_code}>{item.error_code}: {item.count}</div>)}
    </div>
  );
}

function HistoryTable({
  orders,
  expandedCodes,
  onToggle
}: {
  orders: Array<{ externalCode: string; first: OrderRow; items: OrderRow[]; totalQuantity: number }>;
  expandedCodes: Set<string>;
  onToggle: (externalCode: string) => void;
}) {
  if (!orders.length) return <div className="empty">暂无历史运单</div>;
  return (
    <div className="table-wrap history-wrap" style={{ maxHeight: 520 }}>
      <table className="history-table">
        <thead>
          <tr>
            <th>外部编码</th>
            <th>收货门店</th>
            <th>收件人</th>
            <th>电话</th>
            <th>地址</th>
            <th>SKU 物品编码</th>
            <th>SKU 物品名称</th>
            <th>SKU 发货数量</th>
            <th>SKU 规格型号</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {orders.flatMap((order) => {
            const expanded = expandedCodes.has(order.externalCode);
            const uniqueSkuCount = new Set(order.items.map((item) => `${item.skuCode}|${item.skuName}|${item.skuSpec}`)).size;
            return [
              <tr key={`${order.externalCode}-summary`} className="summary-row">
                <td>{order.externalCode}</td>
                <td>{order.first.storeName}</td>
                <td>{order.first.receiverName}</td>
                <td>{order.first.receiverPhone}</td>
                <td>{order.first.receiverAddress}</td>
                <td>SKU 数：{uniqueSkuCount}</td>
                <td />
                <td>总数量：{order.totalQuantity}</td>
                <td />
                <td><button className="link-btn" onClick={() => onToggle(order.externalCode)}>{expanded ? "收起" : "查看明细"}</button></td>
              </tr>,
              ...(expanded ? order.items.map((item, index) => (
                <tr key={`${order.externalCode}-${item.id}-${index}`} className="detail-row">
                  <td>{item.externalCode}</td>
                  <td>{item.storeName}</td>
                  <td>{item.receiverName}</td>
                  <td>{item.receiverPhone}</td>
                  <td>{item.receiverAddress}</td>
                  <td>{item.skuCode}</td>
                  <td>{item.skuName}</td>
                  <td>{item.quantity}</td>
                  <td>{item.skuSpec}</td>
                  <td>明细 {index + 1}</td>
                </tr>
              )) : [])
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
