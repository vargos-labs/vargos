import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { Bus, Service } from '../../core/types.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('edge-browser');

export class BrowserEdge implements Service {
  readonly name = 'edge-browser';
  private child: ChildProcess | null = null;
  private running = false;
  private reason: string | null = null;

  async init(bus: Bus): Promise<void> {
    const port = Number(process.env.VARGOS_DASHBOARD_PORT || 9005);
    const url = process.env.VARGOS_BROWSER_URL || `http://127.0.0.1:${port}`;
    bus.register('browser.status', {
      description: 'Browser dashboard status.',
      schema: z.object({}),
    }, () => ({ port, url, running: this.running, pid: this.child?.pid ?? null, reason: this.reason }));
    if (process.env.VARGOS_CLI_ONESHOT) return;

    const servers = await bus.call<Array<{ name: string; enabled: boolean; connected: boolean }>>('mcp.list');
    const name = process.env.VARGOS_BROWSER_MCP_SERVER || 'playwright';
    const mcp = servers.find(server => server.name === name);
    if (!mcp?.enabled || !mcp.connected) {
      this.reason = 'Playwright MCP is disabled or disconnected.';
      return;
    }

    const script = process.env.VARGOS_BROWSER_SCRIPT;
    if (!script || !existsSync(script)) {
      this.reason = 'Browser dashboard software is not configured.';
      log.warn('Browser dashboard disabled: set VARGOS_BROWSER_SCRIPT.');
      return;
    }

    const child = spawn(process.execPath, [script, '--host', '127.0.0.1', '--port', String(port)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.on('exit', () => {
      this.running = false;
      if (this.child === child) this.child = null;
    });
    child.stderr?.on('data', (data: Buffer) => log.warn(data.toString().trim()));

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => done(new Error('Dashboard startup timed out')), 10000);
        const done = (error?: Error) => {
          clearTimeout(timer);
          child.off('error', onError);
          child.off('exit', onExit);
          child.stdout?.off('data', onData);
          if (error) reject(error); else resolve();
        };
        const onError = (error: Error) => done(error);
        const onExit = () => done(new Error('Dashboard exited before listening'));
        let output = '';
        const onData = (data: Buffer) => {
          output += data.toString();
          if (output.includes('Listening on ')) done();
        };
        child.once('error', onError);
        child.once('exit', onExit);
        child.stdout?.on('data', onData);
      });
      this.reason = null;
      this.running = true;
      log.info(`Browser dashboard ready on 127.0.0.1:${port}`);
    } catch (error) {
      await this.dispose();
      this.reason = 'Browser dashboard failed to start.';
      log.warn(`Browser dashboard disabled: ${String(error)}`);
    }
  }

  async dispose(): Promise<void> {
    this.running = false;
    const child = this.child;
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      // Stop only our child; never kill another dashboard's singleton.
      child.stdin?.end();
      child.kill('SIGTERM');
    });
    this.child = null;
  }
}

export function createService(): Service {
  return new BrowserEdge();
}
