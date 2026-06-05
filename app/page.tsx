"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  FileInput,
  FileSpreadsheet,
  Loader2,
  Menu,
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
import { parseWithRule, validateRows } from "@/lib/rule-engine";
import { CanonicalField, ExtractedFile, fieldLabels, OrderRow, ParseRule, ValidationError, emptyOrderRow } from "@/lib/types";

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
  "remark"
];

const previewFieldOrder: CanonicalField[] = editableFields;
const cardReceiverFields: CanonicalField[] = ["storeName", "receiverName", "receiverPhone", "receiverAddress"];
const cardItemFields: CanonicalField[] = ["skuCode", "skuName", "quantity", "skuSpec", "remark"];

type PreviewColumn =
  | { kind: "field"; field: CanonicalField; label: string }
  | { kind: "source"; key: string; label: string };

type HistoryOrder = {
  externalCode: string;
  rows: OrderRow[];
  first: OrderRow;
  totalQuantity: number;
};

const columnKey = (column: PreviewColumn) => column.kind === "field" ? `field-${column.field}` : `source-${column.key}`;

const readColumnValue = (row: OrderRow, column: PreviewColumn) =>
  column.kind === "field" ? row[column.field] : row.sourceValues?.[column.key] ?? "";

function groupHistoryRows(rows: OrderRow[]): HistoryOrder[] {
  const groups = new Map<string, OrderRow[]>();
  rows.forEach((row) => {
    const key = row.externalCode || `未编码-${row.id}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  });
  return Array.from(groups.entries()).map(([externalCode, groupRows]) => ({
    externalCode,
    rows: groupRows,
    first: groupRows[0],
    totalQuantity: groupRows.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0)
  }));
}

function makePreviewColumns(rule: ParseRule | null, rows: OrderRow[]): PreviewColumn[] {
  const mappedFields = rule?.mappings?.map((mapping) => mapping.target) ?? [];
  const valuedFields = previewFieldOrder.filter((field) => rows.some((row) => String(row[field] ?? "").trim()));
  const structuralFields = rule?.sourceKind === "matrix" ? ["externalCode", "storeName", "skuCode", "skuName", "quantity", "skuSpec", "remark"] as CanonicalField[] : [];
  const selected = [...mappedFields, ...structuralFields, ...valuedFields].filter((field, index, list) => list.indexOf(field) === index);
  const sourceKeys = rule?.sourceKind === "matrix"
    ? [
        ...(rule.matrix?.preserveFields ?? []),
        ...rows.flatMap((row) => Object.keys(row.sourceValues ?? {}))
      ].filter((key, index, list) => key && list.indexOf(key) === index)
    : [];
  const sourceColumns: PreviewColumn[] = sourceKeys.map((key) => ({ kind: "source", key, label: key }));
  const fieldColumns: PreviewColumn[] = previewFieldOrder
    .filter((field) => selected.includes(field))
    .map((field) => {
      const mappingLabel = rule?.mappings?.find((mapping) => mapping.target === field)?.source;
      const matrixLabel = rule?.sourceKind === "matrix"
        ? ({ externalCode: "外部编码", storeName: "收货门店", skuCode: mappingLabel || "SKU条码", skuName: mappingLabel || "SKU名称", quantity: "下单数量", skuSpec: mappingLabel || "规格", remark: "门店列" } as Partial<Record<CanonicalField, string>>)[field]
        : undefined;
      return { kind: "field", field, label: matrixLabel || mappingLabel || fieldLabels[field] };
    });
  return [...sourceColumns, ...fieldColumns];
}

const makeManualRule = (): ParseRule => ({
  id: crypto.randomUUID(),
  name: "新建空白规则",
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

export default function Page() {
  const [file, setFile] = useState<ExtractedFile | null>(null);
  const [rules, setRules] = useState<ParseRule[]>([]);
  const [activeRule, setActiveRule] = useState<ParseRule | null>(null);
  const [ruleDraft, setRuleDraft] = useState("");
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [history, setHistory] = useState<OrderRow[]>([]);
  const [keyword, setKeyword] = useState("");
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState("");
  const [activeTab, setActiveTab] = useState<"import" | "history">("import");
  const [rawInfo, setRawInfo] = useState("");
  const [historyPage, setHistoryPage] = useState(1);
  const [previewPage, setPreviewPage] = useState(1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void refreshRules();
    void refreshHistory();
  }, []);

  useEffect(() => {
    setErrors(validateRows(rows, history.map((row) => row.externalCode)));
  }, [rows, history]);

  const errorMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    errors.forEach((error) => {
      const set = map.get(error.rowId) ?? new Set<string>();
      set.add(error.field);
      map.set(error.rowId, set);
    });
    return map;
  }, [errors]);

  async function refreshRules() {
    const res = await fetch("/api/rules");
    const data = await res.json();
    setRules(data.rules ?? []);
  }

  async function refreshHistory(search = "") {
    const res = await fetch(`/api/orders?keyword=${encodeURIComponent(search)}`);
    const data = await res.json();
    setHistory(data.rows ?? []);
  }

  async function handleFiles(files: FileList | null) {
    const selected = files?.[0];
    if (!selected) return;
    try {
      setBusy("正在读取文件");
      setProgress(12);
      const extracted = await extractFile(selected);
      setFile(extracted);
      setRawInfo("");
      setProgress(40);
      toast.success("文件读取完成");
      await generateRule(extracted);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "文件解析失败");
    } finally {
      setBusy("");
      setProgress(100);
      setTimeout(() => setProgress(0), 800);
    }
  }

  async function generateRule(targetFile = file) {
    if (!targetFile) {
      toast.error("请先上传文件");
      return;
    }
    setBusy("AI 正在生成规则");
    setProgress(55);
    const res = await fetch("/api/ai-rule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(targetFile)
    });
    const data = await res.json();
    setActiveRule(data.rule);
    setRuleDraft(JSON.stringify(data.rule, null, 2));
    setProgress(80);
    toast.success(data.note ?? `规则已生成：${data.usedModel}`);
    setBusy("");
  }

  async function saveRule() {
    try {
      const parsed = JSON.parse(ruleDraft) as ParseRule;
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
    setActiveRule(rule);
    setRuleDraft(JSON.stringify(rule, null, 2));
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

  async function copyRule(rule: ParseRule) {
    const copied: ParseRule = {
      ...rule,
      id: crypto.randomUUID(),
      name: `${rule.name} 副本`,
      updatedAt: new Date().toISOString()
    };
    const res = await fetch("/api/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(copied)
    });
    const data = await res.json();
    setActiveRule(data.rule);
    setRuleDraft(JSON.stringify(data.rule, null, 2));
    await refreshRules();
    toast.success("规则已复制");
  }

  function executeParse() {
    if (!file) return toast.error("请先上传文件");
    try {
      const rule = JSON.parse(ruleDraft) as ParseRule;
      setBusy("正在执行解析");
      setProgress(20);
      const start = performance.now();
      const parsed = parseWithRule(file, rule);
      if (!parsed.length) {
        setRawInfo(file.text.slice(0, 3000) || file.sheets.map((sheet) => `${sheet.name}: ${sheet.rows.length} 行`).join("\n"));
        toast.error("未解析出有效数据，请检查规则配置");
        return;
      }
      setRows(parsed);
      setPreviewPage(1);
      setProgress(100);
      toast.success(`解析完成 ${parsed.length} 行，用时 ${Math.round(performance.now() - start)}ms`);
    } catch {
      if (file) setRawInfo(file.text.slice(0, 3000) || file.sheets.map((sheet) => `${sheet.name}: ${sheet.rows.length} 行`).join("\n"));
      toast.error("规则 JSON 格式不正确，无法解析");
    } finally {
      setBusy("");
      setTimeout(() => setProgress(0), 800);
    }
  }

  function updateCell(rowId: string, field: CanonicalField, value: string) {
    setRows((current) => current.map((row) => (row.id === rowId ? { ...row, [field]: field === "quantity" ? value : value } : row)));
  }

  function updateGroupCells(rowIds: string[], field: CanonicalField, value: string) {
    const ids = new Set(rowIds);
    setRows((current) => current.map((row) => (ids.has(row.id) ? { ...row, [field]: value } : row)));
  }

  function deleteRow(rowId: string) {
    setRows((current) => current.filter((row) => row.id !== rowId));
  }

  function exportExcel() {
    const columns: PreviewColumn[] = previewColumns.length ? previewColumns : editableFields.map((field) => ({ kind: "field", field, label: fieldLabels[field] }));
    const data = rows.map((row) => Object.fromEntries(columns.map((column) => [column.label, readColumnValue(row, column)])));
    const sheet = XLSX.utils.json_to_sheet(data);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "预览数据");
    XLSX.writeFile(book, "智能导入预览.xlsx");
  }

  async function submitOrders() {
    if (errors.length) return toast.error("存在校验错误，请先修正");
    if (!rows.length) return toast.error("没有可提交的数据");
    setBusy("正在提交下单");
    setProgress(15);
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rows)
    });
    const data = await res.json();
    setProgress(100);
    setBusy("");
    toast.success(`提交成功 ${data.success} 条，失败 ${data.failed} 条`);
    setRows([]);
    await refreshHistory();
    setHistoryPage(1);
    setTimeout(() => setProgress(0), 800);
  }

  const pageSize = 10;
  const historyOrders = useMemo(() => groupHistoryRows(history), [history]);
  const totalHistoryPages = Math.max(1, Math.ceil(historyOrders.length / pageSize));
  const pagedHistory = historyOrders.slice((historyPage - 1) * pageSize, historyPage * pageSize);
  const previewPageSize = 100;
  const totalPreviewPages = Math.max(1, Math.ceil(rows.length / previewPageSize));
  const pagedRows = rows.slice((previewPage - 1) * previewPageSize, previewPage * previewPageSize);
  const previewRule = useMemo(() => {
    try {
      return ruleDraft ? JSON.parse(ruleDraft) as ParseRule : activeRule;
    } catch {
      return activeRule;
    }
  }, [activeRule, ruleDraft]);
  const previewColumns = useMemo(() => makePreviewColumns(previewRule, rows), [previewRule, rows]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">ZT</div>
          <div>
            <div className="brand-title">中通冷链</div>
            <div className="brand-sub">ZTO COLD CHAIN</div>
          </div>
        </div>
        <div className="org-row"><Menu size={16} />总部<ChevronDown size={16} style={{ marginLeft: "auto" }} /></div>
        <div className="nav-search"><Search size={15} /><input placeholder="输入菜单名称" /></div>
        <button className={`nav-item nav-button ${activeTab === "import" ? "active" : ""}`} onClick={() => setActiveTab("import")}>
          <UploadCloud size={16} />智能导入
        </button>
        <button className={`nav-item nav-button ${activeTab === "history" ? "active" : ""}`} onClick={() => setActiveTab("history")}>
          <ClipboardList size={16} />已导入运单
        </button>
      </aside>

      <main className="main">
        <header className="topbar" aria-label="顶部导航背景">
          <div className="top-nav" />
        </header>
        <div className="tabs">
          <button onClick={() => setActiveTab("import")}>《</button>
          <button className={`tab ${activeTab === "import" ? "active" : ""}`} onClick={() => setActiveTab("import")}>智能导入批量下单 ×</button>
          <button className={`tab ${activeTab === "history" ? "active" : ""}`} onClick={() => setActiveTab("history")}>已导入运单</button>
          <button style={{ marginLeft: "auto" }} onClick={() => { void refreshRules(); void refreshHistory(keyword); toast.success("已刷新"); }}><RefreshCw size={16} /></button>
        </div>

        <section className="content">
          {activeTab === "import" && <div className="grid-2">
            <div className="panel rule-editor">
              <div className="upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void handleFiles(event.dataTransfer.files); }}>
                <div>
                  <strong>上传任意格式出库单</strong>
                  <div className="muted">支持 Excel / Word / PDF，先由 LLM 生成规则，再人工确认解析</div>
                  {file && <div className="muted">当前文件：{file.fileName}</div>}
                </div>
                <input ref={inputRef} hidden type="file" accept=".xlsx,.xls,.csv,.docx,.pdf,.txt" onChange={(event) => void handleFiles(event.target.files)} />
                <button className="btn primary" onClick={() => inputRef.current?.click()}><UploadCloud size={16} />导入</button>
              </div>
              {progress > 0 && <div style={{ marginTop: 10 }}><div className="progress"><span style={{ width: `${progress}%` }} /></div><div className="muted">{busy || "处理完成"} {progress}%</div></div>}
              <div className="toolbar" style={{ paddingInline: 0 }}>
                <div className="toolbar-group">
                  <button className="btn soft" onClick={() => void generateRule()} disabled={!file || Boolean(busy)}>{busy.includes("AI") ? <Loader2 size={15} className="spin" /> : <FileInput size={15} />}AI生成规则</button>
                  <button className="btn" onClick={() => useRule(makeManualRule())}><Plus size={15} />新建规则</button>
                  <button className="btn primary" onClick={saveRule}><Save size={15} />保存规则</button>
                  <button className="btn primary" onClick={executeParse}><CheckCircle2 size={15} />试解析</button>
                </div>
              </div>
              <textarea className="textarea" value={ruleDraft} onChange={(event) => setRuleDraft(event.target.value)} placeholder="上传文件后生成或手动填写解析规则 JSON" />
              <div className="muted" style={{ marginTop: 8 }}>AI 推测映射会在 JSON 中以 guessed/confidence 标记，保存前可手动微调。</div>
            </div>

            <div className="panel rule-editor">
              <div className="toolbar" style={{ paddingInline: 0, paddingTop: 0 }}>
                <strong>解析规则库</strong>
                <span className="muted">手动选择规则，不自动匹配</span>
              </div>
              {rules.length === 0 && <div className="empty">暂无已保存规则</div>}
              {rules.map((rule) => (
                <div className={`rule-card ${activeRule?.id === rule.id ? "active" : ""}`} key={rule.id} onClick={() => useRule(rule)}>
                  <div className="rule-card-head">
                    <strong>{rule.name}</strong>
                    <span className="rule-actions">
                      <button className="link-btn" onClick={(event) => { event.stopPropagation(); void copyRule(rule); }}>复制</button>
                      <button className="link-btn danger-text" onClick={(event) => { event.stopPropagation(); void deleteRule(rule); }}>删除</button>
                    </span>
                  </div>
                  <div className="muted">{rule.description}</div>
                  <div className="muted">类型：{rule.sourceKind} · Sheet：{rule.sheetMode} · 映射：{rule.mappings.length}</div>
                </div>
              ))}
            </div>
          </div>}

          {activeTab === "import" && <div className="panel">
            <div className="toolbar">
              <div className="toolbar-group">
                <button className="btn primary" onClick={() => { setRows((current) => [emptyOrderRow(), ...current]); setPreviewPage(1); }}><Plus size={15} />新增</button>
                <button className="btn danger" onClick={() => setRows((current) => current.slice(1))}><Trash2 size={15} />删除首行</button>
                <button className="btn soft" onClick={exportExcel} disabled={!rows.length}><ArrowDownToLine size={15} />导出Excel</button>
                <button className="btn primary" onClick={submitOrders} disabled={Boolean(busy) || errors.length > 0 || rows.length === 0}><Send size={15} />提交下单</button>
              </div>
              <div className="toolbar-group">
                <span className={`status-pill ${errors.length ? "bad" : "ok"}`}>{errors.length ? `${errors.length} 个错误` : "校验通过"}</span>
                <span className="muted">共 {rows.length} 条 · 每页渲染 {previewPageSize} 条</span>
              </div>
            </div>
            {previewRule?.sourceKind === "cards" ? (
              <CardPreview rule={previewRule} rows={pagedRows} errors={errorMap} onItemChange={updateCell} onGroupChange={updateGroupCells} onDelete={deleteRow} />
            ) : (
              <EditableTable rows={pagedRows} columns={previewColumns} errors={errorMap} onChange={updateCell} onDelete={deleteRow} startIndex={(previewPage - 1) * previewPageSize} />
            )}
            <div className="pager">
              <span>预览 {rows.length} 条</span>
              <button className="btn" disabled={previewPage <= 1} onClick={() => setPreviewPage((page) => Math.max(1, page - 1))}>上一页</button>
              <span>{previewPage} / {totalPreviewPages}</span>
              <button className="btn" disabled={previewPage >= totalPreviewPages} onClick={() => setPreviewPage((page) => Math.min(totalPreviewPages, page + 1))}>下一页</button>
            </div>
            {errors.length > 0 && (
              <div className="error-list">
                {errors.map((error, index) => <div key={`${error.rowId}-${index}`}>第 {error.rowNumber} 行 · {error.field === "row" ? "整行" : fieldLabels[error.field]}：{error.message}</div>)}
              </div>
            )}
            {rawInfo && (
              <div className="raw-info">
                <strong>原始文件信息</strong>
                <pre>{rawInfo}</pre>
              </div>
            )}
          </div>}

          <div className="panel history" id="history-panel">
            <div className="toolbar">
              <div className="toolbar-group"><FileSpreadsheet size={16} /><strong>已导入运单列表</strong><span className="muted">从服务端读取，支持筛选分页展示</span></div>
              <div className="toolbar-group">
                <input className="input" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="外部编码/姓名/门店" />
                <button className="btn primary" onClick={() => { setHistoryPage(1); void refreshHistory(keyword); }}>查询</button>
              </div>
            </div>
            <HistoryTable orders={pagedHistory} />
            <div className="pager">
              <span>共 {historyOrders.length} 单 / {history.length} 条明细</span>
              <button className="btn" disabled={historyPage <= 1} onClick={() => setHistoryPage((page) => Math.max(1, page - 1))}>上一页</button>
              <span>{historyPage} / {totalHistoryPages}</span>
              <button className="btn" disabled={historyPage >= totalHistoryPages} onClick={() => setHistoryPage((page) => Math.min(totalHistoryPages, page + 1))}>下一页</button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function EditableTable({ rows, columns, errors, onChange, onDelete, startIndex = 0 }: { rows: OrderRow[]; columns: PreviewColumn[]; errors: Map<string, Set<string>>; onChange: (rowId: string, field: CanonicalField, value: string) => void; onDelete: (rowId: string) => void; startIndex?: number }) {
  if (!rows.length) return <div className="empty">上传文件并执行试解析后，结构化订单会显示在这里</div>;
  const visibleColumns: PreviewColumn[] = columns.length ? columns : editableFields.map((field) => ({ kind: "field", field, label: fieldLabels[field] }));
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>序号</th>{visibleColumns.map((column) => <th key={columnKey(column)}>{column.label}</th>)}<th>操作</th></tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const rowErrors = errors.get(row.id);
            return (
              <tr key={row.id} className={rowErrors?.size ? "error-row" : ""}>
                <td>{startIndex + index + 1}</td>
                {visibleColumns.map((column) => (
                  <td key={columnKey(column)} className={(column.kind === "field" && (rowErrors?.has(column.field) || rowErrors?.has("row"))) ? "error-cell" : ""}>
                    {column.kind === "field" ? (
                      <input value={String(row[column.field] ?? "")} onChange={(event) => onChange(row.id, column.field, event.target.value)} />
                    ) : (
                      <span className="readonly-cell">{String(readColumnValue(row, column) ?? "")}</span>
                    )}
                  </td>
                ))}
                <td><button className="link-btn danger-text" onClick={() => onDelete(row.id)}>删除</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CardPreview({ rule, rows, errors, onItemChange, onGroupChange, onDelete }: { rule: ParseRule | null; rows: OrderRow[]; errors: Map<string, Set<string>>; onItemChange: (rowId: string, field: CanonicalField, value: string) => void; onGroupChange: (rowIds: string[], field: CanonicalField, value: string) => void; onDelete: (rowId: string) => void }) {
  if (!rows.length) return <div className="empty">上传文件并执行试解析后，结构化订单会显示在这里</div>;
  const receiverColumns = cardReceiverFields.map((field) => ({ field, label: rule?.card?.infoLabels?.[field] || fieldLabels[field] }));
  const itemColumns = cardItemFields.map((field) => ({ field, label: rule?.card?.itemHeaderLabels?.[field] || fieldLabels[field] }));
  const groups = Array.from(rows.reduce((map, row) => {
    const key = row.externalCode || row.remark || row.id;
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
    return map;
  }, new Map<string, OrderRow[]>()).values());

  return (
    <div className="card-preview">
      {groups.map((group) => {
        const first = group[0];
        const rowIds = group.map((row) => row.id);
        const hasError = group.some((row) => errors.get(row.id)?.size);
        return (
          <div className="order-card" key={first.externalCode || first.remark || first.id}>
            <div className="order-card-head">
              <strong>{first.remark || first.externalCode || "调拨记录"}</strong>
              <span className={`status-pill ${hasError ? "bad" : "ok"}`}>{group.length} 个 SKU</span>
            </div>
            <div className="card-info-grid">
              {receiverColumns.map((column) => (
                <label key={column.field}>
                  <span>{column.label}</span>
                  <input value={String(first[column.field] ?? "")} onChange={(event) => onGroupChange(rowIds, column.field, event.target.value)} />
                </label>
              ))}
            </div>
            <div className="table-wrap card-items">
              <table>
                <thead><tr>{itemColumns.map((column) => <th key={column.field}>{column.label}</th>)}<th>操作</th></tr></thead>
                <tbody>
                  {group.map((row) => {
                    const rowErrors = errors.get(row.id);
                    return (
                      <tr key={row.id} className={rowErrors?.size ? "error-row" : ""}>
                        {itemColumns.map((column) => (
                          <td key={column.field} className={rowErrors?.has(column.field) || rowErrors?.has("row") ? "error-cell" : ""}>
                            <input value={String(row[column.field] ?? "")} onChange={(event) => onItemChange(row.id, column.field, event.target.value)} />
                          </td>
                        ))}
                        <td><button className="link-btn danger-text" onClick={() => onDelete(row.id)}>删除</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HistoryTable({ orders }: { orders: HistoryOrder[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (!orders.length) return <div className="empty">暂无历史运单</div>;
  return (
    <div className="table-wrap history-wrap" style={{ maxHeight: 420 }}>
      <table className="history-table">
        <thead><tr><th>外部编码</th><th>收货门店</th><th>收件人姓名</th><th>收件人电话</th><th>收件人地址</th><th>SKU数</th><th>总数量</th><th>操作</th></tr></thead>
        <tbody>
          {orders.map((order) => {
            const isOpen = expanded[order.externalCode] ?? true;
            return (
              <Fragment key={order.externalCode}>
                <tr key={order.externalCode} className="history-order-row">
                  <td>{order.externalCode}</td>
                  <td>{order.first.storeName}</td>
                  <td>{order.first.receiverName}</td>
                  <td>{order.first.receiverPhone}</td>
                  <td>{order.first.receiverAddress}</td>
                  <td>{order.rows.length}</td>
                  <td>{order.totalQuantity}</td>
                  <td><button className="link-btn" onClick={() => setExpanded((current) => ({ ...current, [order.externalCode]: !isOpen }))}>{isOpen ? "收起明细" : "展开明细"}</button></td>
                </tr>
                {isOpen && (
                  <tr key={`${order.externalCode}-items`} className="history-detail-row">
                    <td colSpan={8}>
                      <table className="history-detail-table">
                        <thead><tr><th>SKU物品编码</th><th>SKU物品名称</th><th>SKU发货数量</th><th>SKU规格型号</th><th>备注</th></tr></thead>
                        <tbody>
                          {order.rows.map((row) => (
                            <tr key={row.id}>
                              <td>{row.skuCode}</td><td>{row.skuName}</td><td>{row.quantity}</td><td>{row.skuSpec}</td><td>{row.remark}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
