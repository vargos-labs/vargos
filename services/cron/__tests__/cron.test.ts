import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EmitterBus } from '../../../core/bus.js';
import { CronService } from '../index.js';
import type { CronTask, CronAddParams, CronUpdateParams } from '../../config/index.js';

describe('CronService — Markdown File CRUD', () => {
  let tempDir: string;
  let cronDir: string;
  let bus: EmitterBus;
  let service: CronService;

  const search = (query = '') => bus.call<{ items: CronTask[] }>('cron.list', { query, page: 1, limit: 10 });
  const add = (p: CronAddParams) => bus.call('cron.add', p);
  const remove = (id: string) => bus.call('cron.remove', { id });
  const update = (p: CronUpdateParams) => bus.call('cron.update', p);

  async function startService(): Promise<void> {
    service = new CronService(cronDir);
    bus.beginLoading('cron');
    await service.init(bus);
    bus.endLoading();
  }

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `cron-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cronDir = path.join(tempDir, 'cron');
    await fs.mkdir(cronDir, { recursive: true });
    bus = new EmitterBus();
  });

  afterEach(async () => {
    service?.dispose();
    bus.releaseService('cron');
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('loads empty task list when no files exist', async () => {
    await startService();
    expect((await search()).items).toHaveLength(0);
  });

  it('writes task with metadata to markdown file', async () => {
    await startService();
    await add({ name: 'Test Task', schedule: '0 9 * * *', task: 'Test task prompt' });

    const files = await fs.readdir(cronDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.md$/);
    const content = await fs.readFile(path.join(cronDir, files[0]), 'utf-8');
    expect(content).toContain('name: Test Task');
    expect(content).toContain('schedule: 0 9 * * *'); // plain scalar — YAML reads it back as a string
    expect(content).toContain('Test task prompt');
  });

  it('parses metadata from markdown frontmatter correctly', async () => {
    await fs.writeFile(path.join(cronDir, 'test-task.md'),
      `---\nid: test-task\nname: "Test Task"\nschedule: "0 9 * * *"\nenabled: true\n---\n\nTest prompt`);
    await startService();

    const result = await search();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: 'test-task', name: 'Test Task', schedule: '0 9 * * *', enabled: true, task: 'Test prompt' });
  });

  it('persists a per-task model override across a reload', async () => {
    await startService();
    const added = await add({ name: 'Local Model Task', schedule: '0 9 * * *', task: 'Use the local box', model: 'vargos-110:vllm:qwen3.8-27b-uncensored' });
    expect(added).toMatchObject({ model: 'vargos-110:vllm:qwen3.8-27b-uncensored' });

    service.dispose();
    bus.releaseService('cron');
    await startService(); // fresh instance reads the frontmatter back from disk

    const result = await search();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].model).toBe('vargos-110:vllm:qwen3.8-27b-uncensored');
  });

  it('deletes markdown file when task is removed', async () => {
    await startService();
    await add({ name: 'Task to Delete', schedule: '0 9 * * *', task: 'Will be deleted' });

    const taskId = (await search()).items[0].id;
    await remove(taskId);

    expect((await search()).items).toHaveLength(0);
    expect(await fs.readdir(cronDir)).toHaveLength(0);
  });

  it('updates markdown file with new metadata and body', async () => {
    await startService();
    await add({ name: 'Original Name', schedule: '0 9 * * *', task: 'Original prompt' });

    const taskId = (await search()).items[0].id;
    await update({ id: taskId, name: 'Updated Name', task: 'Updated prompt' });

    const updated = await search();
    expect(updated.items[0].name).toBe('Updated Name');
    expect(updated.items[0].task).toBe('Updated prompt');
  });

  it('does not persist ephemeral tasks (heartbeat)', async () => {
    await fs.writeFile(path.join(cronDir, 'heartbeat.md'),
      `---\nid: heartbeat\nname: "Heartbeat"\nschedule: "*/30 * * * *"\nenabled: false\n---\n\nHeartbeat check`);
    await startService();
    // Ephemeral heartbeat is excluded from search results.
    expect((await search('heartbeat')).items).toHaveLength(0);
  });

  describe('YAML array parsing', () => {
    it('parses multi-line notify array from markdown', async () => {
      await fs.writeFile(path.join(cronDir, 'notify-task.md'),
        `---\nid: notify-task\nname: "Task with Notifications"\nschedule: "0 9 * * *"\nenabled: true\nnotify:\n  - whatsapp:61423222658\n  - telegram:987654321\n---\n\nSend results to channels`);
      await startService();
      const result = await search();
      expect(result.items[0].notify).toEqual(['whatsapp:61423222658', 'telegram:987654321']);
    });

    it('parses activeHours array from markdown', async () => {
      await fs.writeFile(path.join(cronDir, 'hours-task.md'),
        `---\nid: hours-task\nname: "Task with Active Hours"\nschedule: "0 * * * *"\nenabled: true\nactiveHours: [8, 18]\nactiveHoursTimezone: "Australia/Sydney"\n---\n\nOnly runs 8am-6pm Sydney time`);
      await startService();
      const result = await search();
      expect(result.items[0].activeHours).toEqual([8, 18]);
      expect(result.items[0].activeHoursTimezone).toBe('Australia/Sydney');
    });

    it('handles empty notify array in markdown', async () => {
      await fs.writeFile(path.join(cronDir, 'no-notify.md'),
        `---\nid: no-notify\nname: "Task without notifications"\nschedule: "0 9 * * *"\nenabled: true\nnotify: []\n---\n\nThis task runs but sends no notifications`);
      await startService();
      expect((await search()).items[0].notify).toEqual([]);
    });

    it('handles missing notify field', async () => {
      await fs.writeFile(path.join(cronDir, 'no-notify-field.md'),
        `---\nid: no-notify-field\nname: "Task without notify field"\nschedule: "0 9 * * *"\nenabled: true\n---\n\nTask with no notification configuration`);
      await startService();
      expect((await search()).items[0].notify).toBeUndefined();
    });
  });

  describe('Schema validation', () => {
    const expectRejected = async (filename: string, content: string) => {
      await fs.writeFile(path.join(cronDir, filename), content);
      await startService();
      expect((await search()).items).toHaveLength(0);
    };

    it('rejects task missing required id field', () =>
      expectRejected('no-id.md', `---\nname: "Task without ID"\nschedule: "0 9 * * *"\n---\n\nThis should fail validation`));

    it('rejects task missing required schedule field', () =>
      expectRejected('no-schedule.md', `---\nid: no-schedule\nname: "Task without schedule"\n---\n\nThis should fail validation`));

    it('rejects task with empty task body', () =>
      expectRejected('empty-body.md', `---\nid: empty-body\nname: "Task with empty body"\nschedule: "0 9 * * *"\n---\n\n`));

    it('accepts valid task with all optional fields', async () => {
      await fs.writeFile(path.join(cronDir, 'complete.md'),
        `---\nid: complete-task\nname: "Complete Task"\nschedule: "0 9 * * *"\nenabled: true\nnotify:\n  - whatsapp:61423222658\nactiveHours: [8, 22]\nactiveHoursTimezone: "Australia/Sydney"\n---\n\nThis is a complete task with all optional fields`);
      await startService();
      const task = (await search()).items[0];
      expect(task).toMatchObject({
        id: 'complete-task', name: 'Complete Task', schedule: '0 9 * * *', enabled: true,
        notify: ['whatsapp:61423222658'], activeHours: [8, 22], activeHoursTimezone: 'Australia/Sydney',
      });
    });

    it('uses id as fallback for name if name is missing', async () => {
      await fs.writeFile(path.join(cronDir, 'fallback-name.md'),
        `---\nid: fallback-name\nschedule: "0 9 * * *"\n---\n\nTask prompt without explicit name field`);
      await startService();
      expect((await search()).items[0].name).toBe('fallback-name');
    });

    it('prefers title field over name field', async () => {
      await fs.writeFile(path.join(cronDir, 'title-priority.md'),
        `---\nid: title-priority\ntitle: "Title Takes Priority"\nname: "Name Field"\nschedule: "0 9 * * *"\n---\n\nTask prompt`);
      await startService();
      expect((await search()).items[0].name).toBe('Title Takes Priority');
    });
  });

  describe('Error handling', () => {
    it('skips tasks with invalid type values', async () => {
      await fs.writeFile(path.join(cronDir, 'invalid-types.md'),
        `---\nid: invalid-types\nname: "Invalid Types"\nschedule: "0 9 * * *"\nactiveHours: [8, 25]\n---\n\nactiveHours has invalid hour (25)`);
      await startService();
      expect((await search()).items).toHaveLength(0);
    });

    it('handles files without YAML frontmatter gracefully', async () => {
      await fs.writeFile(path.join(cronDir, 'no-frontmatter.md'), `Just a regular markdown file with no YAML frontmatter at all`);
      await startService();
      expect((await search()).items).toHaveLength(0);
    });

    it('continues loading other tasks when one fails validation', async () => {
      await fs.writeFile(path.join(cronDir, 'invalid.md'), `---\nname: "Missing required fields"\n---\n\nThis should fail`);
      await fs.writeFile(path.join(cronDir, 'valid.md'), `---\nid: valid-task\nname: "Valid Task"\nschedule: "0 9 * * *"\n---\n\nThis should load`);
      await startService();
      const result = await search();
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('valid-task');
    });
  });
});
