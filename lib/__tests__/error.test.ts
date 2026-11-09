import { describe, it, expect } from 'vitest';
import { isPermissionError, permissionHint } from '../error.js';

const DATA = '/home/u/.vargos';

/** An fs-style errno error, shaped like the one Node throws. */
const fsErr = (code: string, syscall: string, path?: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: synthetic`), { code, syscall, path });

describe('permissionHint', () => {
  it('ignores errors that are not permission problems', () => {
    expect(isPermissionError(fsErr('ENOSPC', 'write', DATA))).toBe(false);
    expect(permissionHint(fsErr('ENOSPC', 'write', DATA), DATA)).toBeNull();
    expect(permissionHint(new Error('boom'), DATA)).toBeNull();
    expect(permissionHint('EACCES', DATA)).toBeNull();
  });

  it.each(['EACCES', 'EPERM'])('reclaims the whole data dir for %s on a file inside it', (code) => {
    const hint = permissionHint(fsErr(code, 'open', `${DATA}/workspace/AGENTS.md`), DATA)!;

    expect(hint).toContain(`${code}: open ${DATA}/workspace/AGENTS.md`);
    expect(hint).toContain(`sudo chown -R "$(id -un)" "${DATA}"`);
  });

  it('targets only the failing path when it is outside the data dir', () => {
    const hint = permissionHint(fsErr('EACCES', 'mkdir', '/home/u/.cache/vargos'), DATA)!;

    expect(hint).toContain('sudo chown -R "$(id -un)" "/home/u/.cache/vargos"');
    expect(hint).not.toContain(`"${DATA}"`);
  });

  it('does not treat a sibling dir with the same prefix as inside the data dir', () => {
    const hint = permissionHint(fsErr('EACCES', 'open', '/home/u/.vargos-old/x'), DATA)!;

    expect(hint).toContain('"/home/u/.vargos-old/x"');
  });

  it('suggests a writable VARGOS_DATA_DIR on a read-only filesystem', () => {
    const hint = permissionHint(fsErr('EROFS', 'open', `${DATA}/config.json`), DATA)!;

    expect(hint).toContain('read-only');
    expect(hint).toContain('VARGOS_DATA_DIR=');
    expect(hint).not.toContain('chown');
  });

  it('keeps the explanation short — reason, failing call, one fix line', () => {
    const lines = permissionHint(fsErr('EACCES', 'open', `${DATA}/config.json`), DATA)!.split('\n');

    expect(lines).toHaveLength(3);
    expect(lines.filter(l => l.includes('Fix'))).toHaveLength(1);
  });
});
