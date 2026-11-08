import { describe, expect, it, vi } from 'vitest';
import { StatusReactionController } from '../status-reactions.js';

describe('awaitable status reactions', () => {
  it('waits for queued reactions, including duplicate terminal calls', async () => {
    let finish!: () => void;
    const react = vi.fn(async (_recipient: string, _message: string, emoji: string) => {
      if (emoji === '👍') await new Promise<void>(resolve => { finish = resolve; });
    });
    const controller = new StatusReactionController({ react }, 'chat', 'message');
    await controller.setWorking();
    const done = controller.setDone();
    let completed = false;
    const duplicate = controller.setDone().then(() => { completed = true; });
    await Promise.resolve();
    expect(react.mock.calls.map(call => call[2])).toEqual(['🤔', '👍']);
    expect(completed).toBe(false);
    finish();
    await Promise.all([done, duplicate]);
    expect(completed).toBe(true);
    expect(react).toHaveBeenCalledTimes(2);
  });

  it('keeps failed reactions non-critical', async () => {
    const react = vi.fn().mockRejectedValue(new Error('Unavailable'));
    const controller = new StatusReactionController({ react }, 'chat', 'message');
    await expect(controller.setWorking()).resolves.toBeUndefined();
    await expect(controller.setError()).resolves.toBeUndefined();
    expect(react).toHaveBeenLastCalledWith('chat', 'message', '❗');
  });
});
