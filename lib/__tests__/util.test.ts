import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Wrap copyFile so a test can force the cross-filesystem failure an LXC + NFS data dir produces.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, copyFile: vi.fn(actual.copyFile) };
});

import { copyFile } from 'node:fs/promises';
import { copyFileResilient } from '../util.js';

const mockCopyFile = vi.mocked(copyFile);

/** A copy_file_range(2)-style errno. */
const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: synthetic`), { code });

describe('copyFileResilient', () => {
  let dir: string;
  let src: string;
  let dest: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vargos-util-'));
    src = path.join(dir, 'src.txt');
    dest = path.join(dir, 'dest.txt');
    await writeFile(src, 'template payload');
  });

  afterEach(async () => {
    // vi.mock replaced copyFile for this whole file — put the real implementation back.
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    mockCopyFile.mockImplementation(actual.copyFile);
    await rm(dir, { recursive: true, force: true });
  });

  it('copies with fs.copyFile when that works', async () => {
    await copyFileResilient(src, dest);

    expect(mockCopyFile).toHaveBeenCalledWith(src, dest);
    expect(await readFile(dest, 'utf-8')).toBe('template payload');
  });

  // EXDEV is the real one (local disk -> NFS); the others are the errnos that surface from the
  // kernel's own fallback and from close(2) on filesystems that cannot cross-copy.
  it.each(['EXDEV', 'EACCES', 'EPERM', 'EOPNOTSUPP', 'EINVAL'])(
    'falls back to read+write when copyFile fails with %s',
    async (code) => {
      mockCopyFile.mockRejectedValue(errno(code));

      await copyFileResilient(src, dest);

      expect(await readFile(dest, 'utf-8')).toBe('template payload');
    },
  );

  it('propagates unrelated errors instead of masking them', async () => {
    mockCopyFile.mockRejectedValue(errno('ENOSPC'));

    await expect(copyFileResilient(src, dest)).rejects.toThrow('ENOSPC');
  });
});
