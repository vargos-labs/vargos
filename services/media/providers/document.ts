/**
 * Local document text extraction — PDF, DOCX, XLSX, TXT, MD
 * No external API calls, pure Node.js library-based extraction
 */

import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { PDFParse } from 'pdf-parse';
import * as mammoth from 'mammoth';
import XLSX from 'xlsx';
import { createLogger } from '../../../lib/logger.js';
import { toMessage } from '../../../lib/error.js';
import { getDataPaths } from '../../../lib/paths.js';
import { boundForContext, DEFAULT_MAX_EXTRACT_CHARS } from '../bound-text.js';

const log = createLogger('media');

const MAX_DOCUMENT_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_TEXT_SIZE = 1 * 1024 * 1024; // 1 MB for text files
const BINARY_MIME_PREFIXES = ['image/', 'audio/', 'video/'];
const BINARY_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.avif', '.ico',
  '.mp3', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.flac', '.aac', '.webm',
  '.mp4', '.mov', '.avi', '.mkv', '.wmv',
  '.zip', '.rar', '.7z', '.gz', '.bz2', '.xz', '.tar', '.bin', '.exe', '.dll', '.so',
]);

/**
 * Validate and resolve document path to prevent traversal attacks
 */
async function validatePath(filePath: string): Promise<string> {
  const dataDir = getDataPaths().dataDir;
  const resolved = path.resolve(filePath);

  const rel = path.relative(dataDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path outside workspace: ${filePath}`);
  }

  const fileStats = await lstat(resolved);
  if (fileStats.isSymbolicLink()) {
    throw new Error(`Symlinks not allowed: ${filePath}`);
  }

  if (!fileStats.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }

  const ext = path.extname(resolved).toLowerCase();
  const maxSize = ext === '.txt' || ext === '.md' ? MAX_TEXT_SIZE : MAX_DOCUMENT_SIZE;
  if (fileStats.size > maxSize) {
    throw new Error(`Document too large: ${fileStats.size} bytes (max ${maxSize})`);
  }

  return resolved;
}

async function extractRaw(validatedPath: string, normalizedMime: string, ext: string): Promise<string> {
  // Plain text formats
  if (normalizedMime === 'text/plain' || normalizedMime === 'text/markdown' || ext === '.txt' || ext === '.md') {
    return readFile(validatedPath, 'utf-8').then(t => t.replace(/^\uFEFF/, ''));
  }

  // PDF extraction
  if (normalizedMime === 'application/pdf' || ext === '.pdf') {
    const buffer = await readFile(validatedPath);
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return result.text;
  }

  // DOCX extraction
  if (normalizedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === '.docx') {
    const result = await mammoth.extractRawText({ path: validatedPath });
    return result.value;
  }

  // XLSX extraction
  if (normalizedMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || ext === '.xlsx') {
    const buffer = await readFile(validatedPath);
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheets = workbook.SheetNames;
    const texts: string[] = [];

    for (const sheet of sheets) {
      texts.push(`## Sheet: ${sheet}\n`);
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheet]!);
      texts.push(csv);
    }

    return texts.join('\n');
  }

  // Fallback: try to read as text — but reject binary payloads first. A WhatsApp
  // image arriving as a "document" (mime text/* or application/octet-stream) used to
  // end up here, and its raw bytes became agent message text (~1MB = ~230k tokens),
  // pinning the session over the model context limit in an overflow-compaction loop.
  const buffer = await readFile(validatedPath);
  const looksBinary =
    BINARY_MIME_PREFIXES.some(p => normalizedMime.startsWith(p)) ||
    BINARY_EXTS.has(ext) ||
    buffer.subarray(0, 8192).includes(0); // NUL byte = binary
  if (looksBinary) {
    return `[binary file: ${path.basename(validatedPath)} (${buffer.length} bytes, ${normalizedMime || ext || 'unknown type'}) — not text-extractable; file on disk at ${validatedPath}]`;
  }
  return buffer.toString('utf-8');
}

export async function extractDocument(
  filePath: string,
  mimeType: string,
  opts: { maxChars?: number } = {},
): Promise<{ text: string }> {
  try {
    const validatedPath = await validatePath(filePath);
    const ext = path.extname(validatedPath).toLowerCase();
    const normalizedMime = mimeType.split(';')[0].trim().toLowerCase();
    const maxChars = opts.maxChars ?? DEFAULT_MAX_EXTRACT_CHARS;

    const raw = await extractRaw(validatedPath, normalizedMime, ext);
    const text = await boundForContext(raw, `${validatedPath}.extracted.txt`, maxChars, 'extracted text');
    return { text };
  } catch (err) {
    const errorMsg = toMessage(err);
    log.error(`Document extraction failed for ${filePath}: ${errorMsg}`);
    throw new Error(`Failed to extract document: ${errorMsg}`, { cause: err });
  }
}
