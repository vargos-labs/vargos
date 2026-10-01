import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync, mkdirSync, symlinkSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { extractDocument } from '../providers/document.js';
import { DEFAULT_MAX_EXTRACT_CHARS } from '../bound-text.js';
import { resetDataPaths } from '../../../lib/paths.js';

describe('extractDocument', () => {
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.VARGOS_DATA_DIR;
    tempDir = path.join(os.tmpdir(), `vargos-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    process.env.VARGOS_DATA_DIR = tempDir;
    resetDataPaths();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.VARGOS_DATA_DIR;
    else process.env.VARGOS_DATA_DIR = originalEnv;
    resetDataPaths();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('text formats', () => {
    it('extracts plain text from .txt files', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      const content = 'Hello, this is a test file.';
      writeFileSync(filePath, content, 'utf-8');

      const result = await extractDocument(filePath, 'text/plain');

      expect(result.text).toBe(content);
    });

    it('extracts markdown from .md files', async () => {
      const filePath = path.join(tempDir, 'test.md');
      const content = '# Hello\n\nThis is markdown.';
      writeFileSync(filePath, content, 'utf-8');

      const result = await extractDocument(filePath, 'text/markdown');

      expect(result.text).toBe(content);
    });

    it('strips UTF-8 BOM from text files', async () => {
      const filePath = path.join(tempDir, 'bom.txt');
      const content = '﻿Hello with BOM';
      writeFileSync(filePath, content, 'utf-8');

      const result = await extractDocument(filePath, 'text/plain');

      expect(result.text).toBe('Hello with BOM');
    });

    it('handles mime type with charset parameter', async () => {
      const filePath = path.join(tempDir, 'file.txt');
      const content = 'Content with charset';
      writeFileSync(filePath, content, 'utf-8');

      const result = await extractDocument(filePath, 'text/plain; charset=utf-8');

      expect(result.text).toBe(content);
    });

    it('detects text format by extension when mime is unknown', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      const content = 'Extension detected';
      writeFileSync(filePath, content, 'utf-8');

      const result = await extractDocument(filePath, 'application/octet-stream');

      expect(result.text).toBe(content);
    });

    it('handles files with uppercase extensions', async () => {
      const filePath = path.join(tempDir, 'test.TXT');
      const content = 'Uppercase extension';
      writeFileSync(filePath, content, 'utf-8');

      const result = await extractDocument(filePath, 'text/plain');

      expect(result.text).toBe(content);
    });
  });

  describe('unknown formats', () => {
    it('falls back to text reading for unknown types', async () => {
      const filePath = path.join(tempDir, 'test.xyz');
      const content = 'readable as text';
      writeFileSync(filePath, content, 'utf-8');

      const result = await extractDocument(filePath, 'application/xyz');

      expect(result.text).toBe(content);
    });

    it('throws when file does not exist', async () => {
      const filePath = path.join(tempDir, 'nonexistent.txt');

      await expect(extractDocument(filePath, 'text/plain')).rejects.toThrow('Failed to extract document');
    });
  });

  describe('path validation', () => {
    it('rejects paths outside workspace', async () => {
      await expect(extractDocument('/invalid/path/file.txt', 'text/plain')).rejects.toThrow('Path outside workspace');
    });

    it('rejects symlinks', async () => {
      const targetFile = path.join(tempDir, 'target.txt');
      const symlinkPath = path.join(tempDir, 'link.txt');
      writeFileSync(targetFile, 'content', 'utf-8');
      symlinkSync(targetFile, symlinkPath);

      await expect(extractDocument(symlinkPath, 'text/plain')).rejects.toThrow('Symlinks not allowed');
    });

    it('rejects directories', async () => {
      const dirPath = path.join(tempDir, 'subdir');
      mkdirSync(dirPath);

      await expect(extractDocument(dirPath, 'text/plain')).rejects.toThrow('Not a regular file');
    });
  });

  describe('file size limits', () => {
    it('rejects text files exceeding 1 MB', async () => {
      const filePath = path.join(tempDir, 'large.txt');
      const largeContent = 'x'.repeat(1024 * 1024 + 1);
      writeFileSync(filePath, largeContent, 'utf-8');

      await expect(extractDocument(filePath, 'text/plain')).rejects.toThrow('Document too large');
    });

    it('accepts text files within 1 MB limit and under the context budget', async () => {
      const filePath = path.join(tempDir, 'medium.txt');
      const content = 'x'.repeat(90_000); // below DEFAULT_MAX_EXTRACT_CHARS
      writeFileSync(filePath, content, 'utf-8');

      const result = await extractDocument(filePath, 'text/plain');

      expect(result.text).toBe(content);
    });

    it('rejects documents exceeding 50 MB size limit by extension check', async () => {
      const filePath = path.join(tempDir, 'large.md');
      const largeContent = 'x'.repeat(1024 * 1024 + 1);
      writeFileSync(filePath, largeContent, 'utf-8');

      // .md uses 1 MB text limit, should reject
      await expect(extractDocument(filePath, 'text/markdown')).rejects.toThrow('Document too large');
    });
  });

  describe('context budget', () => {
    it('truncates over-budget text and persists the full extracted text', async () => {
      const filePath = path.join(tempDir, 'big.txt');
      const content = 'x'.repeat(250_000);
      writeFileSync(filePath, content, 'utf-8');

      const result = await extractDocument(filePath, 'text/plain');

      expect(result.text.startsWith('x'.repeat(DEFAULT_MAX_EXTRACT_CHARS))).toBe(true);
      expect(result.text).toContain('truncated');
      const fullPath = `${filePath}.extracted.txt`;
      expect(result.text).toContain(fullPath);
      expect(existsSync(fullPath)).toBe(true);
      expect(readFileSync(fullPath, 'utf-8')).toBe(content);
    });

    it('honors a custom maxChars budget', async () => {
      const filePath = path.join(tempDir, 'custom.txt');
      const content = 'abcdefghij'.repeat(10); // 100 chars
      writeFileSync(filePath, content, 'utf-8');

      const result = await extractDocument(filePath, 'text/plain', { maxChars: 25 });

      expect(result.text.startsWith(content.slice(0, 25))).toBe(true);
      expect(result.text).toContain('truncated');
      expect(readFileSync(`${filePath}.extracted.txt`, 'utf-8')).toBe(content);
    });

    it('does not write an extracted file when under budget', async () => {
      const filePath = path.join(tempDir, 'small.txt');
      writeFileSync(filePath, 'short', 'utf-8');

      await extractDocument(filePath, 'text/plain', { maxChars: 100 });

      expect(existsSync(`${filePath}.extracted.txt`)).toBe(false);
    });

    it('applies the same budget to the unknown-format fallback', async () => {
      const filePath = path.join(tempDir, 'big.xyz');
      const content = 'y'.repeat(150_000);
      writeFileSync(filePath, content, 'utf-8');

      const result = await extractDocument(filePath, 'application/xyz', { maxChars: 1_000 });

      expect(result.text).toContain('truncated');
      expect(readFileSync(`${filePath}.extracted.txt`, 'utf-8')).toBe(content);
    });
  });

  describe('unicode handling', () => {
    it('preserves unicode content', async () => {
      const filePath = path.join(tempDir, 'unicode.txt');
      const content = 'Hello 👋 世界 مرحبا';
      writeFileSync(filePath, content, 'utf-8');

      const result = await extractDocument(filePath, 'text/plain');

      expect(result.text).toBe(content);
    });
  });

  describe('empty files', () => {
    it('handles empty text files', async () => {
      const filePath = path.join(tempDir, 'empty.txt');
      writeFileSync(filePath, '', 'utf-8');

      const result = await extractDocument(filePath, 'text/plain');

      expect(result.text).toBe('');
    });
  });
});
