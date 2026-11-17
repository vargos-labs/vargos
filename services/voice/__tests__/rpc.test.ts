import { it, expect } from 'vitest';
import { createServer, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EmitterBus } from '../../../core/bus.js';
import { startRpcServer } from '../../../core/rpc-server.js';

it('Python reads resolved config and receives errors through the existing RPC server', async () => {
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const bus = new EmitterBus();
  bus.register('config.get', { description: 'test', schema: z.object({}) }, () => ({ voice: { port: 18765 }, agent: { voice: { model: 'configured-model' } } }));
  const stop = await startRpcServer(bus, '127.0.0.1', port);
  const child = spawn('python3', ['-c', `
from vargos_voice.rpc import call
config = call('config.get')
assert config['voice']['port'] == 18765
assert config['agent']['voice']['model'] == 'configured-model'
try:
    call('missing.method')
except RuntimeError:
    pass
else:
    raise AssertionError('RPC errors must propagate')
`], {
    cwd: fileURLToPath(new URL('../../../runtime/voice', import.meta.url)),
    env: { ...process.env, VARGOS_RPC_HOST: '127.0.0.1', VARGOS_RPC_PORT: String(port), VARGOS_DATA_DIR: path.join('/tmp', 'no-config-files-needed'), PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  try {
    const [code] = await once(child, 'exit');
    expect(stderr).toBe('');
    expect(code).toBe(0);
  } finally { child.kill(); await stop(); }
});
