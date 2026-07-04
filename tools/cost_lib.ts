import { getModelRates } from "./stark_config_lib.ts";

/**
 * Cost of one model dispatch from token counts × configured rates.
 * Unknown models use the `_fallback` rate. Single home for token→USD so
 * the challenge, fix-plan, and fold paths agree.
 */
export function computeDispatchCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates = getModelRates();
  const rate = rates[model] ?? rates._fallback;
  return (
    (inputTokens / 1_000_000) * rate.input_per_1m_usd +
    (outputTokens / 1_000_000) * rate.output_per_1m_usd
  );
}
