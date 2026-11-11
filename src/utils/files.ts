/**
 * File system utilities
 */

import fs from 'fs-extra';
import path from 'node:path';
import { validateFile } from './validation.js';
import { SIZES, TIMEOUTS } from '../constants.js';

/**
 * Get file size in human-readable format
 */
export async function getFileSizeString(filePath: string): Promise<string> {
  try {
    const stats = await fs.stat(filePath);
    const bytes = stats.size;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(SIZES.KB));
    return `${(bytes / Math.pow(SIZES.KB, i)).toFixed(1)} ${sizes[i]}`;
  } catch {
    return 'unknown size';
  }
}

/**
 * Calculate dynamic timeout based on file size
 */
export async function calculateTimeout(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath);
    const fileSizeMB = stats.size / SIZES.MB;
    const timeout = TIMEOUTS.BASE + Math.floor(fileSizeMB * TIMEOUTS.PER_MB);
    return Math.min(timeout, TIMEOUTS.MAX);
  } catch {
    return TIMEOUTS.BASE;
  }
}

/**
 * Calculate dynamic timeout based on file size (sync version)
 */
export function calculateTimeoutSync(filePath: string): number {
  try {
    const stats = fs.statSync(filePath);
    const fileSizeMB = stats.size / SIZES.MB;
    const timeout = TIMEOUTS.BASE + Math.floor(fileSizeMB * TIMEOUTS.PER_MB);
    return Math.min(timeout, TIMEOUTS.MAX);
  } catch {
    return TIMEOUTS.BASE;
  }
}

/**
 * Generate a safe filename from package name and version
 */
export function generateFilename(name: string, version: string): string {
  return `${name.replace('/', '-').replace('@', '')}-${version}.tgz`;
}

/** Read an exclusion list: one exact package name per line. */
export async function readExcludedPackages(filePath: string): Promise<string[]> {
  const resolvedPath = path.resolve(filePath);
  await validateFile(resolvedPath, 'Exclude packages file');
  const content = await fs.readFile(resolvedPath, 'utf8');
  const names = content.split(/\r?\n/).map((line) => line.trim());
  return [...new Set(names.filter((name) => name.length > 0 && !name.startsWith('#')))];
}
