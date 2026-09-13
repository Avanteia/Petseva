import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { formatINR } from '@rms/shared';
import { AiProvider, InsightAnomaly, InsightSummaryInput, PricingSuggestion, PricingSuggestionInput } from './ai-provider.interface';
import { MockAiProvider } from './mock-ai.provider';

/**
 * Claude-backed narration. Only ever asked to *phrase* numbers that InsightsService/PricingService
 * already computed via @rms/shared's stats.ts — never to compute a number itself. Falls back to
 * the deterministic MockAiProvider on any error (offline, bad key, rate limit, ...) so a flaky
 * network never breaks an admin screen — it just loses the nicer phrasing for that one request.
 */
@Injectable()
export class AnthropicAiProvider implements AiProvider {
  private readonly log = new Logger('AnthropicAi');
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly fallback = new MockAiProvider();

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  private async complete(prompt: string, maxTokens = 300): Promise<string | null> {
    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      });
      const block = res.content.find((b) => b.type === 'text');
      return block && block.type === 'text' ? block.text.trim() : null;
    } catch (e: any) {
      this.log.warn(`Claude call failed, falling back to mock narration: ${e.message}`);
      return null;
    }
  }

  async generateInsightSummary(input: InsightSummaryInput): Promise<string> {
    const prompt = [
      `You write a one-paragraph daily summary for a restaurant manager. Use ONLY the numbers given — never invent or recompute any figure.`,
      `Outlet: ${input.outletName}. Period: ${input.periodLabel}.`,
      `Sales: ${formatINR(input.sales)} across ${input.billCount} bills (avg ${formatINR(input.avgOrderValue)}).`,
      input.salesVsBaselinePct !== null ? `Vs. the usual level for this day of the week: ${input.salesVsBaselinePct.toFixed(1)}%.` : `Not enough history yet for a weekday comparison.`,
      `${input.anomalies.length} anomalies were flagged separately (do not restate them, just mention the count if relevant).`,
      `Write 2-4 plain sentences, no headings, no markdown.`,
    ].join('\n');
    return (await this.complete(prompt)) ?? this.fallback.generateInsightSummary(input);
  }

  async explainAnomalies(anomalies: InsightAnomaly[]): Promise<string[]> {
    if (!anomalies.length) return [];
    const prompt = [
      `For each flagged anomaly below, write ONE short plain-English sentence explaining what it means for a restaurant manager. Use ONLY the numbers given. Return exactly ${anomalies.length} lines, one per anomaly, no numbering, no markdown.`,
      ...anomalies.map((a, i) => `${i + 1}. kind=${a.kind} label="${a.label}" value=${a.value} baseline=${a.baseline}`),
    ].join('\n');
    const text = await this.complete(prompt, 500);
    if (!text) return this.fallback.explainAnomalies(anomalies);
    const lines = text.split('\n').map((l) => l.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean);
    return lines.length === anomalies.length ? lines : this.fallback.explainAnomalies(anomalies);
  }

  async suggestPricingActions(input: PricingSuggestionInput): Promise<PricingSuggestion[]> {
    // The rule engine (PricingService) has already decided WHICH items/combos are candidates and
    // WHAT kind of action fits each — Claude only phrases them, so we reuse the mock's rule
    // selection and just ask for nicer wording per candidate, falling back per-item on failure.
    const candidates = await this.fallback.suggestPricingActions(input);
    if (!candidates.length) return candidates;
    const prompt = [
      `Rephrase each of these restaurant pricing recommendations in one friendlier sentence, keeping the same meaning and any numbers exactly as given. Return exactly ${candidates.length} lines, no numbering, no markdown.`,
      ...candidates.map((c, i) => `${i + 1}. ${c.title}: ${c.detail}`),
    ].join('\n');
    const text = await this.complete(prompt, 600);
    if (!text) return candidates;
    const lines = text.split('\n').map((l) => l.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean);
    if (lines.length !== candidates.length) return candidates;
    return candidates.map((c, i) => ({ ...c, detail: lines[i] }));
  }
}
