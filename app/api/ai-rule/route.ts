import { NextRequest, NextResponse } from "next/server";
import { buildRulePrompt, makeHeuristicRule } from "@/lib/rule-engine";
import { ExtractedFile, ParseRule } from "@/lib/types";

export const runtime = "nodejs";

const parseJsonFromModel = (content: string): Partial<ParseRule> | null => {
  const fenced = content.match(/```json\s*([\s\S]*?)```/)?.[1] ?? content;
  const json = fenced.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

export async function POST(request: NextRequest) {
  const file = (await request.json()) as ExtractedFile;
  const fallback = makeHeuristicRule(file);
  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = process.env.LLM_BASE_URL ?? "https://api.openai.com";
  const model = process.env.LLM_MODEL ?? "gpt-4o-mini";

  if (!apiKey) {
    return NextResponse.json({
      rule: fallback,
      usedModel: "heuristic-fallback",
      note: "未配置 LLM_API_KEY，已返回启发式推荐规则。"
    });
  }

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "你只输出可被 JSON.parse 解析的规则对象，不输出解释。"
          },
          {
            role: "user",
            content: buildRulePrompt(file)
          }
        ]
      })
    });

    if (!response.ok) throw new Error(`LLM request failed: ${response.status}`);
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content ?? "";
    const generated = parseJsonFromModel(content);

    return NextResponse.json({
      rule: {
        ...fallback,
        ...generated,
        id: fallback.id,
        createdBy: "ai",
        updatedAt: new Date().toISOString()
      },
      usedModel: model
    });
  } catch (error) {
    return NextResponse.json({
      rule: fallback,
      usedModel: "heuristic-fallback",
      note: error instanceof Error ? error.message : "LLM 调用失败，已回退到启发式规则。"
    });
  }
}
