import { neon } from '@neon/ai-sdk-provider';
import { generateText } from 'ai';

/**
 * One model call through the Neon AI Gateway via Neon's AI SDK provider (reads
 * NEON_AI_GATEWAY_BASE_URL + NEON_AI_GATEWAY_TOKEN from env). Lists the branch's enabled models,
 * then asks one for a short reply. Run: `npm run build && npm run ai:sdk-smoke`.
 */
const base = process.env.NEON_AI_GATEWAY_BASE_URL;
const token = process.env.NEON_AI_GATEWAY_TOKEN;
if (!base || !token) throw new Error('NEON_AI_GATEWAY_BASE_URL / _TOKEN not set');

const res = await fetch(`${base}/v1/models`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!res.ok) throw new Error(`GET /v1/models → ${res.status}`);
const { data } = (await res.json()) as {
  data: { id: string; owned_by: string; enabled: boolean }[];
};
const enabled = data.filter((m) => m.enabled);
console.log(`Models on this branch: ${data.length} (${enabled.length} enabled)`);
for (const m of enabled) console.log(`  ${m.id}  [${m.owned_by}]`);

const model = process.argv[2] ?? 'claude-haiku-5-5';
const { text, usage } = await generateText({
  model: neon(model),
  prompt: 'In one short sentence, say hello to a Bangladeshi online shop owner.',
});
console.log(`\n${model} → ${text}`);
console.log(`tokens: in ${usage.inputTokens}, out ${usage.outputTokens}`);
