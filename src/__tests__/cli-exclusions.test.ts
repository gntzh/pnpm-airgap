import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { readExcludedPackages } from '../utils/files.js';
import { createPackageExclusionMatcher } from '../core/package-filter.js';

const { fetchDependencies } = vi.hoisted(() => ({ fetchDependencies: vi.fn() }));
vi.mock('../commands/fetch.js', () => ({ fetchDependencies }));

describe('CLI exclusion files', () => {
  let tempDir: string;
  const originalArgv = process.argv;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pnpm-airgap-cli-'));
    vi.resetModules();
    fetchDependencies.mockReset().mockResolvedValue({ success: true });
    // The CLI exits after its async action; keep the test process running.
    // @ts-expect-error process.exit normally never returns
    vi.spyOn(process, 'exit').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    await fs.remove(tempDir);
  });

  async function runFetch(args: string[] = []): Promise<void> {
    const configPath = path.join(tempDir, 'config.json');
    await fs.writeJson(configPath, { fetch: { excludePackages: ['from-config'] } });
    process.argv = ['node', 'pnpm-airgap', 'fetch', '--config', configPath, ...args];
    await import('../cli.js');
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalled());
  }

  it('reads UTF-8, LF/CRLF, whitespace, comments and duplicates without interpreting patterns', async () => {
    const filename = path.join(tempDir, 'exclude.txt');
    await fs.writeFile(filename, '\uFEFF # comment\r\n @esbuild/darwin-arm64 \r\n\n@esbuild/darwin-arm64\nfoo*\n!bar\nname # literal\n');
    expect(await readExcludedPackages(path.relative(process.cwd(), filename))).toEqual([
      '@esbuild/darwin-arm64', 'foo*', '!bar', 'name # literal',
    ]);
  });

  it('rejects a blank keep exception after file whitespace normalization', async () => {
    const filename = path.join(tempDir, 'blank-keep.txt');
    await fs.writeFile(filename, '@esbuild/*\n!   \r\n');
    const rules = await readExcludedPackages(filename);
    expect(() => createPackageExclusionMatcher(rules)).toThrow('requires a non-empty pattern');
  });

  it('replaces the config list with the file contents', async () => {
    const filename = path.join(tempDir, 'exclude.txt');
    await fs.writeFile(filename, ' from-file* \n! from-file-linux-*\nfrom-file*\n');
    await runFetch(['--exclude-packages', path.relative(process.cwd(), filename)]);
    expect(fetchDependencies).toHaveBeenCalledWith({ excludePackages: ['from-file*', '! from-file-linux-*'] });
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('uses config when the flag is omitted', async () => {
    await runFetch();
    expect(fetchDependencies).toHaveBeenCalledWith({ excludePackages: ['from-config'] });
  });

  it('uses an empty file to disable configured exclusions', async () => {
    const filename = path.join(tempDir, 'empty.txt');
    await fs.writeFile(filename, '\n# comment\n');
    await runFetch(['--exclude-packages', filename]);
    expect(fetchDependencies).toHaveBeenCalledWith({ excludePackages: [] });
  });

  it.each(['missing', 'directory'])('fails before fetching for a %s path', async (kind) => {
    const filename = kind === 'directory' ? tempDir : path.join(tempDir, 'missing.txt');
    await runFetch(['--exclude-packages', filename]);
    expect(fetchDependencies).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalled();
  });

  it('fails before fetching when the file cannot be read', async () => {
    const filename = path.join(tempDir, 'unreadable.txt');
    await fs.writeFile(filename, 'excluded');
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation((...args) => {
      if (args[0] === filename) return Promise.reject(new Error('EACCES: permission denied'));
      return readFile(...args);
    });
    await runFetch(['--exclude-packages', filename]);
    expect(fetchDependencies).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.any(String), 'EACCES: permission denied');
  });
});
