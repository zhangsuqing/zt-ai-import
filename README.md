# 鲸天冷链智能批量下单

Next.js App Router + TypeScript Web 应用，支持 Excel / Word / PDF 文件上传，通过可配置解析规则和 LLM 辅助生成规则，将任意格式出库单转换为结构化批量下单数据。

## 本地运行

```bash
npm install
npm run dev
```

## LLM 配置

在 Vercel 环境变量中配置 OpenAI-compatible 接口：

```bash
LLM_API_KEY=sk-xxx
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
```

未配置时系统会返回可编辑的启发式规则，便于演示完整流程。

## 数据库配置

推荐通过 Vercel Marketplace 绑定 Neon / Vercel Postgres。配置 `POSTGRES_URL` 后，提交下单和规则会写入数据库；未配置时自动使用内存存储，方便本地演示。

## Vercel 部署

```bash
npm run build
vercel --prod
```
