"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  "temperature",
  "remark"
];

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
      setRows(parsed);
      setProgress(100);
      toast.success(`解析完成 ${parsed.length} 行，用时 ${Math.round(performance.now() - start)}ms`);
    } catch {
      toast.error("规则 JSON 格式不正确，无法解析");
    } finally {
      setBusy("");
      setTimeout(() => setProgress(0), 800);
    }
  }

  function updateCell(rowId: string, field: CanonicalField, value: string) {
    setRows((current) => current.map((row) => (row.id === rowId ? { ...row, [field]: field === "quantity" ? value : value } : row)));
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
    setTimeout(() => setProgress(0), 800);
  }

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
        <button className="nav-item active nav-button" onClick={() => setActiveTab("import")}>
          <UploadCloud size={16} />智能导入
        </button>
        <button className="nav-item nav-button" onClick={() => setActiveTab("history")}>
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
                <button className="btn primary" onClick={() => setRows((current) => [emptyOrderRow(), ...current])}><Plus size={15} />新增</button>
                <button className="btn danger" onClick={() => setRows((current) => current.slice(1))}><Trash2 size={15} />删除首行</button>
                <button className="btn soft" onClick={exportExcel} disabled={!rows.length}><ArrowDownToLine size={15} />导出Excel</button>
                <button className="btn primary" onClick={submitOrders} disabled={Boolean(busy) || errors.length > 0 || rows.length === 0}><Send size={15} />提交下单</button>
              </div>
              <div className="toolbar-group">
                <span className={`status-pill ${errors.length ? "bad" : "ok"}`}>{errors.length ? `${errors.length} 个错误` : "校验通过"}</span>
                <span className="muted">共 {rows.length} 条</span>
              </div>
            </div>
            <EditableTable rows={rows} errors={errorMap} onChange={updateCell} />
            {errors.length > 0 && (
              <div className="error-list">
                {errors.map((error, index) => <div key={`${error.rowId}-${index}`}>第 {error.rowNumber} 行 · {error.field === "row" ? "整行" : fieldLabels[error.field]}：{error.message}</div>)}
              </div>
            )}
          </div>}

          <div className="panel history" id="history-panel">
            <div className="toolbar">
              <div className="toolbar-group"><FileSpreadsheet size={16} /><strong>已导入运单列表</strong><span className="muted">从服务端读取，支持筛选分页展示</span></div>
              <div className="toolbar-group">
                <input className="input" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="外部编码/姓名/门店" />
                <button className="btn primary" onClick={() => void refreshHistory(keyword)}>查询</button>
              </div>
            </div>
            <HistoryTable rows={history.slice(0, 30)} />
          </div>
        </section>
      </main>
    </div>
  );
}

function EditableTable({ rows, errors, onChange }: { rows: OrderRow[]; errors: Map<string, Set<string>>; onChange: (rowId: string, field: CanonicalField, value: string) => void }) {
  if (!rows.length) return <div className="empty">上传文件并执行试解析后，结构化订单会显示在这里</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>序号</th><th>状态</th>{editableFields.map((field) => <th key={field}>{fieldLabels[field]}</th>)}<th>来源</th></tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const rowErrors = errors.get(row.id);
            return (
              <tr key={row.id} className={rowErrors?.size ? "error-row" : ""}>
                <td>{index + 1}</td>
                <td><span className={`status-pill ${rowErrors?.size ? "bad" : "ok"}`}>{rowErrors?.size ? "待修正" : "有效"}</span></td>
                {editableFields.map((field) => (
                  <td key={field} className={rowErrors?.has(field) || rowErrors?.has("row") ? "error-cell" : ""}>
                    <input value={String(row[field] ?? "")} onChange={(event) => onChange(row.id, field, event.target.value)} />
                  </td>
                ))}
                <td>{row.sourceSheet ?? "-"} {row.sourceRow ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HistoryTable({ rows }: { rows: OrderRow[] }) {
  if (!rows.length) return <div className="empty">暂无历史运单</div>;
  return (
    <div className="table-wrap" style={{ maxHeight: 320 }}>
      <table>
        <thead><tr><th>外部编码</th><th>收货门店</th><th>收件人</th><th>电话</th><th>SKU</th><th>数量</th><th>温区</th><th>审核状态</th><th>操作</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.externalCode}</td><td>{row.storeName}</td><td>{row.receiverName}</td><td>{row.receiverPhone}</td><td>{row.skuName}</td><td>{row.quantity}</td><td>{row.temperature}</td>
              <td><span className="status-pill ok">审核通过</span></td><td style={{ color: "var(--brand)", fontWeight: 700 }}>详情　编辑　复制　更多⌄</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
