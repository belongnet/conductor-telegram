const endpoint = process.argv.includes('--ready') ? 'ready' : 'live';
try {
  const response = await fetch(`http://127.0.0.1:8787/health/${endpoint}`, {signal: AbortSignal.timeout(4000)});
  process.exit(response.ok ? 0 : 1);
} catch { process.exit(1); }
