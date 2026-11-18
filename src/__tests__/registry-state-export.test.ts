import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { exportRegistryState } from '../commands/registry-state.js';
import * as http from '../utils/http.js';

let tempDir: string;
beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-export-'));
  vi.spyOn(http, 'getAuthHeader').mockResolvedValue(null);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(tempDir);
});

it('exports confirmed versions after listing and metadata failures without recording failures in the file', async () => {
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/_all_docs' && parsed.searchParams.get('skip') === '0') {
      return { data: { rows: [{ id: 'keep' }, { id: 'broken' }], total_rows: 3 } };
    }
    if (parsed.pathname === '/keep') return { data: { name: 'keep', versions: { '1.0.0': {} } } };
    throw new Error('HTTP 503');
  });
  const outputPath = path.join(tempDir, 'nested', 'state.json');
  const result = await exportRegistryState({ registryUrl: 'http://registry.test', outputPath });
  expect(result.success).toBe(false);
  expect(result.errors?.map((item) => item.package)).toEqual(['<listing>', 'broken']);
  const state = await fs.readJson(outputPath);
  expect(state.packages).toEqual({ keep: ['1.0.0'] });
  expect(state.stats).toEqual({ totalPackages: 1, totalVersions: 1 });
  expect(Object.keys(state).sort()).toEqual(['exportedAt', 'packages', 'registry', 'stats', 'version']);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('broken: HTTP 503'));
});

it('writes a valid empty inventory into a new directory', async () => {
  vi.spyOn(axios, 'get').mockResolvedValue({ data: { _updated: 1 } });
  const outputPath = path.join(tempDir, 'nested', 'empty.json');
  expect((await exportRegistryState({ registryUrl: 'http://registry.test', outputPath })).success).toBe(true);
  expect((await fs.readJson(outputPath)).packages).toEqual({});
});

it.each([null, [], { name: 'wrong', versions: { '1.0.0': {} } },
  { name: 'broken', versions: { '1.0.0': null } }])('omits malformed metadata: %j', async (metadata) => {
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (String(url).endsWith('/-/all')) return { data: { broken: { versions: {} } } };
    return { data: metadata };
  });
  const outputPath = path.join(tempDir, 'state.json');
  const result = await exportRegistryState({ registryUrl: 'http://registry.test', outputPath });
  expect(result.success).toBe(false);
  expect(result.errors?.[0].package).toBe('broken');
  expect((await fs.readJson(outputPath)).packages).toEqual({});
});
