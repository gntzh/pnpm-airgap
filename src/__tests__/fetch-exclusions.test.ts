import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { fetchDependencies } from '../commands/fetch.js';
import { generateFilename } from '../utils/files.js';

describe('fetch exclusions', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pnpm-airgap-fetch-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.remove(tempDir);
  });

  it('filters download metadata while keeping existing excluded and old tarballs', async () => {
    const lockfilePath = path.join(tempDir, 'pnpm-lock.yaml');
    await fs.writeFile(lockfilePath, yaml.dump({
      lockfileVersion: '9.0',
      packages: { 'keep@1.0.0': {}, 'exclude@1.0.0': {}, 'exclude@2.0.0': {} },
      snapshots: { 'exclude@3.0.0': {} },
    }));
    const outputDir = path.join(tempDir, 'packages');
    await fs.ensureDir(outputDir);
    const filenames = [
      generateFilename('keep', '1.0.0'),
      generateFilename('keep', '0.9.0'),
      generateFilename('exclude', '1.0.0'),
    ];
    for (const filename of filenames) {
      await fs.writeFile(path.join(outputDir, filename), 'existing tarball');
    }

    const result = await fetchDependencies({ lockfilePath, outputDir, excludePackages: ['exclude'] });
    expect(result).toMatchObject({ success: true, total: 1, downloaded: 0, skipped: 1, failed: 0 });
    const metadata = await fs.readJson(path.join(outputDir, 'metadata.json'));
    expect(metadata.packageCount).toBe(1);
    expect(metadata.packages.map((pkg: { name: string }) => pkg.name)).toEqual(['keep']);
    for (const filename of filenames) {
      expect(await fs.readFile(path.join(outputDir, filename), 'utf8')).toBe('existing tarball');
    }
    expect((await fs.readdir(outputDir)).filter((filename) => filename.endsWith('.tgz')).sort())
      .toEqual([...filenames].sort());
  });
});
