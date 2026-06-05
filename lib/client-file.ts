"use client";

import type { ExtractedFile, SheetData } from "./types";

const extOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

export async function extractFile(file: File): Promise<ExtractedFile> {
  if (file.size === 0) throw new Error("文件为空，请重新选择有效文件");
  const ext = extOf(file.name);
  if (["xlsx", "xls", "csv"].includes(ext)) return extractExcel(file);
  if (ext === "docx") return extractWord(file);
  if (ext === "pdf") return extractPdf(file);
  if (ext === "txt") {
    const text = await file.text();
    if (!text.trim()) throw new Error("文件内容为空，请检查后重新上传");
    return { fileName: file.name, fileType: "text", sheets: [], text };
  }
  throw new Error("文件格式不支持，请上传 Excel（.xlsx/.xls）、Word（.docx）或 PDF 文件");
}

async function extractExcel(file: File): Promise<ExtractedFile> {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
  const sheets: SheetData[] = workbook.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: "" }) as string[][]
  }));
  if (!sheets.length || !sheets.some((sheet) => sheet.rows.some((row) => row.some((cell) => String(cell ?? "").trim())))) {
    throw new Error("Excel 文件没有可解析的数据");
  }
  const text = sheets.map((sheet) => `${sheet.name}\n${sheet.rows.map((row) => row.join("\t")).join("\n")}`).join("\n\n");
  return { fileName: file.name, fileType: "excel", sheets, text };
}

async function extractWord(file: File): Promise<ExtractedFile> {
  const mammoth = await import("mammoth/mammoth.browser");
  const buffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  if (!result.value.trim()) throw new Error("Word 文件没有可解析的文本内容");
  return {
    fileName: file.name,
    fileType: "word",
    sheets: [{ name: "document", rows: result.value.split(/\r?\n/).map((line) => [line]) }],
    text: result.value
  };
}

async function extractPdf(file: File): Promise<ExtractedFile> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;
  const buffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buffer }).promise;
  const lines: string[] = [];
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    lines.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  const text = lines.join("\n\n");
  if (!text.trim()) throw new Error("PDF 文件没有可解析的文本内容");
  return {
    fileName: file.name,
    fileType: "pdf",
    sheets: [{ name: "pdf", rows: text.split(/\r?\n/).map((line) => line.split(/\s{2,}|\t/)) }],
    text
  };
}
