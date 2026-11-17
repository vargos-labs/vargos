import { cp } from 'node:fs/promises';
import path from 'node:path';

// Package source assets only, never local Python bytecode or environments.
await cp('runtime', 'dist/runtime', {
  recursive: true,
  filter: source => !source.split(path.sep).some(part => ['__pycache__', '.venv', '.git'].includes(part)) && !source.endsWith('.pyc'),
});
