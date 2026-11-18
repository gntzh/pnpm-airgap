import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { listAllPackages } from '../core/registry.js';

afterEach(() => vi.restoreAllMocks());

it('preserves metadata from the legacy package map and ignores _updated', async () => {
  vi.spyOn(axios, 'get').mockResolvedValue({ data: {
    _updated: 1,
    keep: { name: 'keep', versions: { '1.0.0': {} }, 'dist-tags': { latest: '1.0.0' } },
  } });
  const packages = await listAllPackages('http://registry.test');
  expect([...packages.keys()]).toEqual(['keep']);
  expect(packages.get('keep')?.versions).toEqual({ '1.0.0': {} });
  expect(packages.get('keep')?.['dist-tags']).toEqual({ latest: '1.0.0' });
});

it('parses search envelopes and follows server-capped pages', async () => {
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname !== '/-/v1/search') throw new Error('HTTP 404');
    const from = Number(parsed.searchParams.get('from') ?? 0);
    return { data: { objects: from < 2 ? [{ package: { name: `pkg-${from}` } }] : [], total: 1 } };
  });
  const onError = vi.fn();
  const packages = await listAllPackages('http://registry.test', { onError });
  expect([...packages.keys()]).toEqual(['pkg-0', 'pkg-1']);
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('cannot guarantee') }));
  expect(get.mock.calls.some(([url]) => String(url).includes('from=2'))).toBe(true);
});

it('parses CouchDB rows instead of treating envelope keys as package names', async () => {
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (!String(url).includes('/_all_docs')) throw new Error('HTTP 404');
    return { data: { rows: [{ id: '@team/pkg' }, { id: '_design/app' }], total_rows: 2, offset: 0 } };
  });
  expect([...await listAllPackages('http://registry.test')].map(([name]) => name)).toEqual(['@team/pkg']);
});

it('reads the Verdaccio web list including scoped packages', async () => {
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (!String(url).endsWith('/-/verdaccio/data/packages')) throw new Error('HTTP 404');
    return { data: [{ name: 'other' }, { name: '@team/pkg' }] };
  });
  expect([...await listAllPackages('http://registry.test', { scope: '@team' })].map(([name]) => name))
    .toEqual(['@team/pkg']);
});

it('does not mistake a search with no matches for an empty registry', async () => {
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (!String(url).includes('/-/v1/search')) throw new Error('HTTP 404');
    return { data: { objects: [], total: 0 } };
  });
  await expect(listAllPackages('http://registry.test')).rejects.toThrow('not proof of an empty registry');
});

it('keeps discovered names after a failed page and fails closed without an error handler', async () => {
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (String(url).endsWith('/_all_docs?limit=250&skip=0')) {
      return { data: { rows: [{ id: 'keep' }], total_rows: 2 } };
    }
    throw new Error('HTTP 503');
  });
  const onError = vi.fn();
  expect([...await listAllPackages('http://registry.test', { onError })].map(([name]) => name)).toEqual(['keep']);
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('HTTP 503') }));
  await expect(listAllPackages('http://registry.test')).rejects.toThrow('incomplete');
});

it('detects servers ignoring pagination even when scope filters every result', async () => {
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (!String(url).includes('/-/v1/search')) throw new Error('HTTP 404');
    return { data: { objects: [{ package: { name: 'same' } }], total: 100 } };
  });
  await expect(listAllPackages('http://registry.test', { scope: '@team' })).rejects.toThrow('without progress');
  expect(get).toHaveBeenCalledTimes(5);
});

it('advances unfiltered offsets and sends authentication on every page', async () => {
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname !== '/_all_docs') throw new Error('HTTP 404');
    const offset = Number(parsed.searchParams.get('skip'));
    const names = ['other', '@team/keep'];
    return { data: { rows: [{ id: names[offset] }], total_rows: 2 } };
  });
  const packages = await listAllPackages('http://registry.test', {
    authHeader: 'Bearer test-token', scope: '@team',
  });
  expect([...packages.keys()]).toEqual(['@team/keep']);
  expect(get).toHaveBeenLastCalledWith('http://registry.test/_all_docs?limit=250&skip=1',
    expect.objectContaining({ headers: { Authorization: 'Bearer test-token' } }));
});

it('falls back after an invalid response shape without interpreting envelope keys as packages', async () => {
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (String(url).endsWith('/-/all')) return { data: { objects: [], total: 0 } };
    if (String(url).includes('/_all_docs')) return { data: { rows: [{ id: 'keep' }], total_rows: 1 } };
    throw new Error('Unexpected fallback');
  });
  expect([...await listAllPackages('http://registry.test')].map(([name]) => name)).toEqual(['keep']);
});

it('does not fall back after a valid empty inventory', async () => {
  const get = vi.spyOn(axios, 'get').mockResolvedValue({ data: { _updated: 1 } });
  expect((await listAllPackages('http://registry.test')).size).toBe(0);
  expect(get).toHaveBeenCalledTimes(1);
});
