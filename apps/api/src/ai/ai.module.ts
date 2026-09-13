import { Logger, Module } from '@nestjs/common';
import { AI_PROVIDER } from './ai-provider.interface';
import { AnthropicAiProvider } from './anthropic-ai.provider';
import { MockAiProvider } from './mock-ai.provider';

const log = new Logger('AiModule');

/**
 * AI_PROVIDER=mock (default, no key needed) or AI_PROVIDER=anthropic + ANTHROPIC_API_KEY.
 * Mirrors PRINT_DRY_RUN's mock-by-default / opt-in-to-real precedent (see print.service.ts).
 */
@Module({
  providers: [
    {
      provide: AI_PROVIDER,
      useFactory: () => {
        const provider = process.env.AI_PROVIDER ?? 'mock';
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (provider === 'anthropic' && apiKey) {
          log.log('Using AnthropicAiProvider for insights/pricing narration.');
          return new AnthropicAiProvider(apiKey, process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5');
        }
        if (provider === 'anthropic' && !apiKey) log.warn('AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set — falling back to MockAiProvider.');
        return new MockAiProvider();
      },
    },
  ],
  exports: [AI_PROVIDER],
})
export class AiModule {}
