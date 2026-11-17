import { createApp } from './server.ts';

const server = createApp();
try {
  await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(0, '0.0.0.0', resolve); });
} catch (error) {
  console.error('Pocket Forge could not bind its ephemeral port:',error);
  process.exit(1);
}
const port = (server.address() as any).port;
console.log(`Pocket Forge listening on ${port}`);
const env = process.env.MAKEFUN_ENV_URL?.replace(/\/$/, '');
if (env) {
  const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
  for (;;) {
    try {
      const res = await fetch(`${env}/register`, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({port}), signal:AbortSignal.timeout(30000)});
      if (res.ok || res.status === 409) break;
      if (res.status === 400 || res.status === 405) throw new Error(`Registration rejected: ${res.status}`);
    } catch (e) { if (String(e).includes('Registration rejected')) throw e; }
    await pause(500);
  }
  for (;;) {
    try {
      const res = await fetch(`${env}/done`, {signal:AbortSignal.timeout(30000)});
      if (res.ok && (await res.json() as any).done === true) break;
    } catch {}
    await pause(500);
  }
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  process.exit(0);
}
