// Read-only observer. The owner must perform the command/task/question/review/file
// acceptance flow; HTTP readiness alone cannot certify that round trip.
import {appendFileSync} from 'node:fs';
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:8787');
const hours = Number(process.argv[3] ?? 24);
if (!Number.isFinite(hours) || hours <= 0 || hours > 48) throw new Error('Hours must be between 0 and 48');
const filename = process.argv[4] ?? 'gateway-soak.jsonl';
const end = Date.now() + hours * 3600000;
let failures = 0, samples = 0;
while (Date.now() < end) {
  const sample = {at: new Date().toISOString()};
  try {
    const response = await fetch(`${origin.origin}/health/ready`, {signal: AbortSignal.timeout(10000), redirect: 'error'});
    sample.status = response.status; sample.health = await response.json();
    if (!response.ok) failures++;
  } catch { sample.error = 'probe failed'; failures++; }
  samples++; appendFileSync(filename, JSON.stringify(sample) + '\n', {mode: 0o600});
  await new Promise(resolve => setTimeout(resolve, Math.min(60000, Math.max(0, end - Date.now()))));
}
console.log(JSON.stringify({samples, failures, evidence: filename}));
process.exitCode = failures ? 1 : 0;
