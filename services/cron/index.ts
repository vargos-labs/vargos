/**
 * Cron service — schedules and fires periodic tasks.
 *
 * Callable: cron.list, cron.add, cron.remove, cron.update, cron.run
 *
 * Concurrency: one active run per task (via activeTasks set).
 * Lock released on agent.onCompleted for cron sessions.
 *
 * Delivery: after each run, sends result to task's notify targets.
 * Heartbeat OK responses (HEARTBEAT_OK) are pruned silently.
 * Subagent deferral: if subagents are still running, the agent runtime may
 * defer delivery until the parent run completes.
 */

import { CronJob } from 'cron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Bus, Service } from '../../core/types.js';
import type { CronTask, CronAddParams, CronUpdateParams } from '../../services/config/index.js';
import { CronTaskSchema, CronAddSchema, CronUpdateSchema } from '../../services/config/schemas/cron.js';
import { createLogger } from '../../lib/logger.js';
import { toMessage } from '../../lib/error.js';
import { formatZodIssues } from '../../core/errors.js';
import { getDataPaths } from '../../lib/paths.js';
import { generateId } from '../../lib/util.js';
import { filterPaginate, ListSchema, type ListParams } from '../../lib/paginate.js';
import { cronSessionKey, parseSessionKey } from '../../lib/session-key.js';
import { parseFrontmatter, serializeFrontmatter } from '../../lib/frontmatter.js';
import { isWithinActiveHours } from '../../lib/active-hours.js';
import { isHeartbeatContentEffectivelyEmpty, stripHeartbeatToken } from '../../lib/heartbeat.js';

const log = createLogger('cron');

type AgentCompletedPayload = { sessionKey: string; success: boolean };

// ── CronService ───────────────────────────────────────────────────────────────

export const BOOT_PRIORITY = 60; // cron scheduler — listeners last
export class CronService implements Service {
  readonly name = 'cron';
  private jobs = new Map<string, { task: CronTask; job: CronJob }>();
  private ephemeralIds = new Set<string>();
  private activeTasks = new Set<string>();
  private beforeFireHooks = new Map<string, () => Promise<boolean>>();
  private bus!: Bus;
  private cronDir: string;

  constructor(cronDir?: string) {
    this.cronDir = cronDir ?? getDataPaths().cronDir;
  }

  async init(bus: Bus): Promise<void> {
    this.bus = bus;

    this.registerMethods(bus);

    const diskTasks = await this.loadTasksFromDisk();
    for (const task of diskTasks) this.addJob(task);
    if (this.jobs.has('heartbeat')) this.registerHeartbeat();
    this.startAll();

    bus.on('agent.onCompleted', (p: AgentCompletedPayload) => this.onAgentCompleted(p));
    log.info('cron service started');
  }

  /** Stop every CronJob timer — without this, a reload would leave timers firing (D2). */
  dispose(): void {
    this.stopAll();
  }

  private registerMethods(bus: Bus): void {
    bus.register('cron.list', {
      description: 'List scheduled cron tasks.',
      schema: ListSchema,
      cli: { positional: ['query'] },
    }, (p) => this.list(p));

    bus.register('cron.add', {
      description: 'Add a new scheduled cron task.',
      schema: CronAddSchema,
      cli: { positional: ['name', 'schedule', 'task'] },
    }, (p) => this.add(p));

    bus.register('cron.remove', {
      description: 'Remove a scheduled cron task.',
      schema: z.object({ id: z.string() }),
      cli: { positional: ['id'] },
    }, (p) => this.remove(p));

    bus.register('cron.update', {
      description: 'Update a scheduled cron task.',
      schema: CronUpdateSchema,
      cli: { positional: ['id'] },
    }, (p) => this.update(p));

    bus.register('cron.run', {
      description: 'Manually trigger a cron task immediately.',
      schema: z.object({ id: z.string() }),
      cli: { positional: ['id'] },
      live: true, // fires the agent run in the background — needs the daemon to outlive it
    }, (p) => this.run(p));
  }

  // ── Callable handlers ─────────────────────────────────────────────────────

  private list(params: ListParams) {
    const tasks = Array.from(this.jobs.values())
      .filter(e => !this.ephemeralIds.has(e.task.id))
      .map(e => e.task);
    return filterPaginate(tasks, params, t => [t.name, t.id, t.task]);
  }

  private async add(params: CronAddParams): Promise<CronTask> {
    const id = generateId('cron');
    if (this.jobs.has(id)) {
      throw new Error(`Cron task already exists: ${id}`);
    }

    const task: CronTask = { ...params, id, enabled: true };

    // Write to disk
    await this.writeTaskToDisk(task);

    // Register in-memory
    this.addJob(task);
    this.jobs.get(task.id)!.job.start();
    log.info(`task added: ${task.name} (${task.id})`);
    return task;
  }

  private async remove(params: { id: string }): Promise<{ removed: boolean; id: string }> {
    const entry = this.jobs.get(params.id);
    if (!entry) return { removed: false, id: params.id };

    const isEphemeral = this.ephemeralIds.has(params.id);

    entry.job.stop();
    this.jobs.delete(params.id);
    this.ephemeralIds.delete(params.id);
    this.activeTasks.delete(params.id);

    // Delete from disk (only persistent tasks)
    if (!isEphemeral) {
      await this.deleteTaskFromDisk(params.id);
    }

    log.info(`task removed: ${params.id}`);
    return { removed: true, id: params.id };
  }

  private async update(params: CronUpdateParams): Promise<CronTask> {
    const entry = this.jobs.get(params.id);
    if (!entry) throw new Error(`No task with id: ${params.id}`);

    const updates = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== undefined)
    );
    const updated: CronTask = { ...entry.task, ...updates };

    if (params.schedule && params.schedule !== entry.task.schedule) {
      entry.job.stop();
      const job = new CronJob(
        updated.schedule,
        () => this.fire(params.id),
        null,
        updated.enabled,
        'UTC',
      );
      this.jobs.set(params.id, { task: updated, job });
    } else {
      entry.task = updated;
      if (params.enabled === false) entry.job.stop();
      else if (params.enabled === true) entry.job.start();
    }

    // Write to disk (only persistent tasks)
    const isEphemeral = this.ephemeralIds.has(params.id);
    if (!isEphemeral) {
      await this.writeTaskToDisk(updated);
    }

    log.info(`task updated: ${params.id}`);
    return updated;
  }

  private async run(params: { id: string }): Promise<{ started: boolean; id: string }> {
    const entry = this.jobs.get(params.id);
    if (!entry) throw new Error(`No task with id: ${params.id}`);
    // Fire without awaiting — long-running tasks must not block the RPC socket
    this.executeTask(entry.task).catch(err =>
      log.error(`manual run failed: ${params.id}: ${toMessage(err)}`),
    );
    return { started: true, id: params.id };
  }

  // ── Internal scheduling ───────────────────────────────────────────────────

  private addJob(task: CronTask, opts?: { ephemeral?: boolean }): void {
    const job = new CronJob(task.schedule, () => this.fire(task.id), null, false);
    this.jobs.set(task.id, { task, job });
    if (opts?.ephemeral) this.ephemeralIds.add(task.id);
  }

  private startAll(): void {
    let count = 0;
    for (const { task, job } of this.jobs.values()) {
      if (task.enabled) {
        log.debug(`starting job: ${task.id} (${task.schedule})`);
        job.start();
        count++;
      } else {
        log.debug(`skipping disabled job: ${task.id}`);
      }
    }
    log.info(`${count} jobs started`);
  }

  private stopAll(): void {
    for (const { job } of this.jobs.values()) job.stop();
  }

  private fire(id: string): void {
    if (this.activeTasks.has(id)) {
      log.info(`skipping fire — task still active: ${id}`);
      return;
    }
    const entry = this.jobs.get(id);
    if (!entry) {
      log.warn(`fire() called for unknown task: ${id}`);
      return;
    }
    if (!entry.task.enabled) {
      log.debug(`task disabled, not firing: ${id}`);
      return;
    }

    // Check activeHours for all tasks (not just heartbeat)
    if (entry.task.activeHours &&
      !isWithinActiveHours(entry.task.activeHours as [number, number], entry.task.activeHoursTimezone)) {
      log.debug(`task outside active hours, not firing: ${id}`);
      return;
    }

    const hook = this.beforeFireHooks.get(id);
    const check = hook ? hook() : Promise.resolve(true);

    check.then(async (shouldFire) => {
      if (!shouldFire) {
        log.debug(`hook check returned false for ${id}, not firing`);
        return;
      }
      this.activeTasks.add(id);
      try {
        await this.executeTask(entry.task);
      } catch (err) {
        log.error('task execution error', { id, error: err instanceof Error ? err.message : String(err) });
      }
    }).catch(err => log.error(`hook check error: ${id}: ${err}`));
  }

  private onAgentCompleted(payload: AgentCompletedPayload): void {
    const parsed = parseSessionKey(payload.sessionKey);
    if (parsed.type !== 'cron') return;
    // Strip date suffix to recover taskId (e.g. "daily-backup:2026-03-29" → "daily-backup")
    const taskId = parsed.id.replace(/:\d{4}-\d{2}-\d{2}$/, '');
    if (this.activeTasks.delete(taskId)) {
      log.debug(`concurrency lock released: ${taskId}`);
    }
  }

  // ── Task execution ────────────────────────────────────────────────────────

  private async executeTask(task: CronTask): Promise<void> {
    const sessionKey = cronSessionKey(task.id);
    log.info(`⏰ ${task.name} (${task.id})`);

    const result = await this.bus.call<{ response: string }>('agent.execute', {
      sessionKey,
      task: task.task,
      ...(task.model && { model: task.model }),
    });

    if (!result.response) return;

    const cleaned = stripHeartbeatToken(result.response);
    if (cleaned === null) {
      log.debug(`heartbeat no-op: ${task.id}`);
      return;
    }

    if (!task.notify?.length) return;

    // Heartbeat: plain send (omit fromSessionKey so channel.send skips history injection).
    // Other tasks: pass our cron sessionKey so the target session records the cross-session push.
    const isHeartbeat = task.id === 'heartbeat';
    await Promise.all(task.notify.map(target =>
      this.bus.call('channel.send', {
        sessionKey: target,
        text: cleaned,
        ...(isHeartbeat ? {} : { fromSessionKey: sessionKey }),
      }).catch(err => log.error(`notify send to ${target}: ${toMessage(err)}`)),
    ));
  }

  // ── File I/O ──────────────────────────────────────────────────────────────

  private parseMarkdownTask(content: string): { frontmatter: Record<string, unknown>; body: string } | null {
    const result = parseFrontmatter(content);
    if (!result) return null;
    return { frontmatter: result.meta, body: result.body };
  }

  private serializeMarkdownTask(task: CronTask): string {
    const { task: taskPrompt, ...metadata } = task;
    return serializeFrontmatter(metadata, taskPrompt);
  }

  private async loadTasksFromDisk(): Promise<CronTask[]> {
    const tasks: CronTask[] = [];

    try {
      const files = await fs.readdir(this.cronDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));

      if (mdFiles.length === 0) {
        log.debug(`no tasks found in ${this.cronDir}`);
        return tasks;
      }

      for (const filename of mdFiles) {
        try {
          const filepath = path.join(this.cronDir, filename);
          const content = await fs.readFile(filepath, 'utf-8');

          const parsed = this.parseMarkdownTask(content);
          if (!parsed) {
            log.warn(`${filename}: missing or invalid YAML frontmatter (expected --- ... ---)}`);
            continue;
          }

          // Build task object
          const task: CronTask = {
            id: String(parsed.frontmatter.id ?? ''),
            name: String(parsed.frontmatter.title || parsed.frontmatter.name || parsed.frontmatter.id || ''),
            schedule: String(parsed.frontmatter.schedule ?? ''),
            task: parsed.body || '',
            enabled: parsed.frontmatter.enabled === true,
            model: parsed.frontmatter.model ? String(parsed.frontmatter.model) : undefined,
            notify: Array.isArray(parsed.frontmatter.notify) ? parsed.frontmatter.notify.map(String) : undefined,
            activeHours: Array.isArray(parsed.frontmatter.activeHours) ? (parsed.frontmatter.activeHours as number[]).slice(0, 2) as [number, number] : undefined,
            activeHoursTimezone: parsed.frontmatter.activeHoursTimezone ? String(parsed.frontmatter.activeHoursTimezone) : undefined,
          };

          // Validate against schema
          const validation = CronTaskSchema.safeParse(task);
          if (!validation.success) {
            log.error(`${filename}: schema validation failed — ${formatZodIssues(validation.error)}`);
            continue;
          }

          tasks.push(validation.data);
          log.debug(`loaded task: ${task.id}`);

          // Mark heartbeat as ephemeral
          if (task.id === 'heartbeat') {
            this.ephemeralIds.add(task.id);
          }
        } catch (err) {
          log.warn(`${filename}: ${toMessage(err)}`);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        log.debug(`cron directory does not exist yet: ${this.cronDir}`);
      } else {
        log.warn(`failed to read cron directory: ${toMessage(err)}`);
      }
    }

    return tasks;
  }

  private async writeTaskToDisk(task: CronTask): Promise<void> {
    if (!task?.id) {
      throw new Error('Cannot write task without id');
    }

    try {
      await fs.mkdir(this.cronDir, { recursive: true });

      const filepath = path.join(this.cronDir, `${task.id}.md`);
      const tmpPath = `${filepath}.tmp`;

      try {
        const content = this.serializeMarkdownTask(task);
        if (!content) {
          throw new Error('Failed to serialize task');
        }
        await fs.writeFile(tmpPath, content, 'utf-8');
        await fs.rename(tmpPath, filepath);
        log.debug(`wrote task to disk: ${task.id}`);
      } catch (err) {
        try {
          await fs.unlink(tmpPath);
        } catch {
          // Ignore cleanup errors
        }
        throw err;
      }
    } catch (err) {
      log.error(`failed to write task ${task.id}: ${toMessage(err)}`);
      throw err;
    }
  }

  private async deleteTaskFromDisk(taskId: string): Promise<void> {
    const filepath = path.join(this.cronDir, `${taskId}.md`);
    try {
      await fs.unlink(filepath);
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) {
        throw err;
      }
      // File doesn't exist, that's fine
    }
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  private registerHeartbeat(): void {
    const entry = this.jobs.get('heartbeat');
    if (!entry) {
      log.warn('heartbeat task not found in cron tasks');
      return;
    }

    const { workspaceDir } = getDataPaths();
    const activeHours = entry.task.activeHours as [number, number] | undefined;
    const activeHoursTimezone = entry.task.activeHoursTimezone;

    this.beforeFireHooks.set('heartbeat', async () => {
      if (!isWithinActiveHours(activeHours, activeHoursTimezone)) return false;

      const { activeRuns } = await this.bus.call<{ activeRuns: string[] }>('agent.status', {});
      if (activeRuns.length > 0) return false;

      try {
        const content = await fs.readFile(path.join(workspaceDir, 'HEARTBEAT.md'), 'utf-8');
        if (isHeartbeatContentEffectivelyEmpty(content)) return false;
      } catch {
        return false; // missing file
      }

      return true;
    });

    log.info('heartbeat registered');
  }
}

export function createService(): Service {
  return new CronService();
}
