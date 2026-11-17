/** Optional Hugging Face speech runtime, owned by the ordinary Vargos lifecycle. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bus, Service } from '../../core/types.js';
import { RpcClient } from '../../core/rpc-client.js';
import type { AppConfig } from '../config/index.js';
import { getDataPaths } from '../../lib/paths.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('voice');
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../runtime/voice');

export function voiceRuntimeDir(): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(path.join(packageDir, 'requirements.lock')));
  return path.join(getDataPaths().cacheDir, 'voice', hash.digest('hex').slice(0, 16));
}

/** Kill the whole audio process group, including the reference adapter and HF server. */
export async function stopVoiceProcess(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  const signal = (value: NodeJS.Signals) => {
    try { process.kill(-child.pid!, value); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  signal('SIGTERM');
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { signal('SIGKILL'); resolve(); }, 3000);
    child.once('exit', () => {
      // A wrapper can exit before its children. Ensure no member survives it.
      signal('SIGKILL');
      clearTimeout(timer);
      resolve();
    });
    if (child.exitCode !== null || child.signalCode !== null) {
      signal('SIGKILL'); clearTimeout(timer); resolve();
    }
  });
}

export class VoiceService implements Service {
  readonly name = 'voice';
  private child: ChildProcess | null = null;
  private stopping = false;
  private retry?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private runtimeDir = '';
  private gateway!: AppConfig['gateway'];
  private offReady?: () => void;
  private baseUrl = '';

  async init(bus: Bus): Promise<void> {
    this.runtimeDir = voiceRuntimeDir();
    const config = await bus.call<AppConfig>('config.get', {});
    const transport = config.voice;
    this.gateway = config.gateway;
    const connectHost = transport.host === '0.0.0.0' ? '127.0.0.1' : transport.host;
    this.baseUrl = `http://${connectHost}:${transport.port}`;
    if (!config.agent?.voice?.enabled || process.env.VARGOS_CLI_ONESHOT || transport.externalUrl) return;
    if (!existsSync(path.join(this.runtimeDir, 'ready'))) {
      log.warn(`Speech dependencies missing. Run python3 ${path.join(packageDir, 'install.py')} then restart Vargos.`);
      return;
    }
    this.offReady = bus.on('bus.onReady', () => this.start());
    // Service reloads happen after onReady was emitted. Probe the existing RPC
    // gateway too; start() guards against both paths firing.
    const host = this.gateway.host === '0.0.0.0' ? '127.0.0.1' : this.gateway.host;
    void new RpcClient(host, this.gateway.port).isUp().then(ready => { if (ready) this.start(); });
  }

  private start() {
    if (this.stopping || this.child) return;
    this.offReady?.();
    this.offReady = undefined;
    const child = spawn(path.join(this.runtimeDir, '.venv/bin/python'), ['-m', 'vargos_voice.serve'], {
      cwd: packageDir, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, VARGOS_DATA_DIR: getDataPaths().dataDir, VARGOS_VOICE_MANAGED: '1',
        VARGOS_RPC_HOST: this.gateway.host === '0.0.0.0' ? '127.0.0.1' : this.gateway.host,
        VARGOS_RPC_PORT: String(this.gateway.port), PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
    });
    this.child = child;
    this.logOutput(child, 'backend');
    child.once('error', error => { if (this.child === child) this.child = null; log.error(`Speech startup failed: ${error.message}`); });
    child.once('exit', async (code, signal) => {
      await stopVoiceProcess(child);
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      log.warn(`Speech backend exited (${code ?? signal}). Check Vargos logs.`);
      // A bounded retry avoids crashing the daemon or spinning on invalid settings.
      if (this.attempts < 3) {
        const delay = 1000 * 2 ** this.attempts++;
        this.retry = setTimeout(() => this.start(), delay);
      }
    });
    void this.waitUntilReady(child);
  }

  private async waitUntilReady(child: ChildProcess) {
    for (let attempt = 0; attempt < 120 && !this.stopping && this.child === child; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/openapi.json`, { signal: AbortSignal.timeout(500) });
        if (response.ok && this.child === child && !this.stopping) {
          log.info(`Managed speech backend ready at ${this.baseUrl}.`); return;
        }
      } catch { /* The Python process is still loading its models. */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!this.stopping && this.child === child) {
      log.warn('Speech startup timed out.');
      await stopVoiceProcess(child);
    }
  }

  private logOutput(child: ChildProcess, tag: string) {
    const report = (chunk: Buffer) => chunk.toString().split('\n').filter(Boolean).forEach(line => log.info(`[${tag}] ${line}`));
    child.stdout?.on('data', report); child.stderr?.on('data', report);
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.retry);
    this.offReady?.();
    if (this.child) await stopVoiceProcess(this.child);
    this.child = null;
  }
}

export function createService(): Service { return new VoiceService(); }
