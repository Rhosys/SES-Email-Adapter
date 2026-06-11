# ADR-008: Switch Classifier from Claude Opus to Qwen3 32B

**Date:** 2026-06-11  
**Status:** Accepted  
**Deciders:** Warren  

## Context

The signal classifier uses a Bedrock LLM to categorise inbound emails into one of 15 workflows, extract structured `workflowData`, assign a spam score (0–1), generate a one-line summary, and suggest labels. The original implementation used Claude Opus 4.5 via a cross-region EU inference profile (`eu.anthropic.claude-opus-4-5-20251101-v1:0`).

Problems with Claude Opus for this use case:

1. **Cost** — $5.00 / $25.00 per 1M input/output tokens. At 1000 emails/day the classifier alone costs ~$675/month. This is disproportionate for a constrained classification task.
2. **Cross-region inference profile complexity** — requires `inference-profile/*` IAM resources, introduces routing opacity and debugging difficulty (the original AccessDenied error that prompted this change).
3. **Overkill reasoning** — Opus is designed for complex multi-step reasoning. Email classification is a structured extraction task with a fixed schema and deterministic output format. A smaller instruction-following model suffices.

## Decision

Replace Claude Opus 4.5 with **Qwen3 32B** (`qwen.qwen3-32b-v1:0`) for signal classification.

### Why Qwen3 32B

| Factor | Qwen3 32B | Claude Opus 4.5 | Nova Lite |
|--------|-----------|-----------------|-----------|
| Input cost (per 1M tokens) | $0.15 | $5.00 | $0.06 |
| Output cost (per 1M tokens) | $0.60 | $25.00 | $0.24 |
| Monthly cost @ 1000 emails/day | ~$21 | ~$675 | ~$8 |
| Structured JSON output | Strong | Excellent | Adequate |
| Available in eu-central-1 | ✅ (in-region) | Via inference profile | ✅ (cross-region) |
| Context window | 32K | 200K | 300K |
| Max output tokens | 8K | 64K | 10K |

- **Qwen3 32B over Nova Lite**: stronger instruction following and structured output quality for a small cost premium ($21 vs $8/month). The classifier prompt is complex (15 workflows, each with specific field extraction rules) — a more capable model reduces misclassification risk.
- **In-region availability**: Qwen3 32B is directly available in eu-central-1 as a foundation model. No cross-region inference profile needed — simpler IAM (`foundation-model/*` wildcard covers it), no routing ambiguity.
- **Hybrid thinking mode disabled**: Qwen3 supports a reasoning mode, but we disable it (`enable_thinking: false`) for direct JSON output without reasoning token overhead.

### Alternatives rejected

- **Nova Lite** ($0.06/$0.24): cheapest option but weaker at complex structured extraction. Risk of workflow misclassification on edge cases (e.g. distinguishing `auth` from `confirmation`, `support` from `crm`). Fallback if Qwen3 proves too slow.
- **Nova Pro** ($0.80/$3.20): 6× cheaper than Claude but 5× more expensive than Qwen3 with no clear quality advantage for this task.
- **Ministral 14B**: not available in eu-central-1 at time of decision.
- **Llama 3.3 70B**: not available as a serverless option; only legacy Llama 3.2 variants visible.

## Consequences

1. **Request format change** — Anthropic's native format (`anthropic_version`, `system` field, `content[]` response) replaced with OpenAI-compatible format (`messages[]` with system role, `choices[0].message.content` response). This is a code change in `classifier.ts` only.
2. **No embedding migration** — the embedding model (Titan v2) is unchanged. Only the classifier (text generation) model is swapped.
3. **Guardrails** — Bedrock Guardrails still work with Qwen3 via the `bedrock-runtime` endpoint. The guardrail trace format remains the same (though Qwen responses may not populate it — the handler is no-op safe).
4. **Monitoring** — Bedrock invocation logging (added in same deploy) will capture request/response for quality monitoring. If classification quality degrades, revert to Claude Opus or try Nova Pro.
5. **Cost reduction** — ~97% reduction in classifier inference cost ($675 → $21/month at 1000 emails/day).
6. **Future model swaps** — the OpenAI-compatible messages format is more portable than Anthropic's native format. Future model changes (if needed) only require changing the model ID and possibly response parsing.
