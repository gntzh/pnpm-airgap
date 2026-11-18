import axios from 'axios';
import type { PackageMetadata } from './registry.js';
import { TIMEOUTS } from '../constants.js';
import { httpAgent, httpsAgent } from '../utils/http.js';
import { debug } from '../utils/logger.js';

type ReadResponse = (query?: string) => Promise<unknown>;
type ListingAdapter = (read: ReadResponse) => AsyncGenerator<PackageMetadata[]>;

interface ListingPage {
  packages: PackageMetadata[];
  // Includes filtered database rows so offsets do not depend on scope or names.
  count: number;
  done: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && /^(?:@[^/\s]+\/)?[^@/\s]+$/.test(value) && !value.startsWith('_');
}

function namedPackage(name: unknown): PackageMetadata {
  if (!isName(name)) throw new Error('Invalid package name in listing response');
  return { name, versions: {} };
}

/** Validate an entire response before yielding any of its packages. */
async function* readLegacyMap(read: ReadResponse): AsyncGenerator<PackageMetadata[]> {
  const data = await read();
  if (!isRecord(data)) throw new Error('Invalid /-/all package map');
  const packages = Object.entries(data).filter(([name]) => name !== '_updated').map(([name, meta]) => {
    if (!isName(name) || !isRecord(meta) ||
      !(isRecord(meta.versions) || isRecord(meta['dist-tags']))) {
      throw new Error('Invalid /-/all package map');
    }
    return {
      name,
      versions: (meta.versions ?? {}) as PackageMetadata['versions'],
      ...(meta['dist-tags'] ? { 'dist-tags': meta['dist-tags'] as Record<string, string> } : {}),
      ...(meta.time ? { time: meta.time as Record<string, string> } : {}),
    };
  });
  yield packages;
}

async function* readVerdaccioPackages(read: ReadResponse): AsyncGenerator<PackageMetadata[]> {
  const data = await read();
  if (!Array.isArray(data)) throw new Error('Invalid Verdaccio package list');
  yield data.map((item: unknown) => {
    if (!isRecord(item)) throw new Error('Invalid Verdaccio package list');
    return namedPackage(item.name);
  });
}

/** Only offset advancement and progress detection are shared across protocols. */
async function* paginate(readPage: (offset: number) => Promise<ListingPage>): AsyncGenerator<PackageMetadata[]> {
  const seen = new Set<string>();
  let offset = 0;
  for (let pageNumber = 0; pageNumber < 10000; pageNumber++) {
    const page = await readPage(offset);
    yield page.packages;
    if (page.count === 0) return;
    const previousSize = seen.size;
    for (const pkg of page.packages) seen.add(pkg.name);
    if (page.packages.length > 0 && seen.size === previousSize) {
      throw new Error('Listing pagination repeated packages without progress');
    }
    if (page.done) return;
    offset += page.count;
  }
  throw new Error('Listing pagination exceeded 10000 pages');
}

async function* readCouchDocuments(read: ReadResponse): AsyncGenerator<PackageMetadata[]> {
  yield* paginate(async (offset) => {
    const data = await read(`?limit=250&skip=${offset}`);
    if (!isRecord(data) || !Array.isArray(data.rows)) {
      throw new Error('Invalid CouchDB response: missing rows');
    }
    const packages: PackageMetadata[] = [];
    for (const row of data.rows) {
      if (!isRecord(row) || typeof row.id !== 'string') throw new Error('Invalid CouchDB row');
      if (row.id.startsWith('_design/') || row.id.startsWith('_local/')) continue;
      packages.push(namedPackage(row.id));
    }
    return {
      packages,
      count: data.rows.length,
      done: data.rows.length === 0 ||
        (Number.isInteger(data.total_rows) && offset + data.rows.length >= Number(data.total_rows)),
    };
  });
}

async function* readSearchResults(read: ReadResponse): AsyncGenerator<PackageMetadata[]> {
  yield* paginate(async (offset) => {
    const data = await read(`?text=*&size=250&from=${offset}`);
    if (!isRecord(data) || !Array.isArray(data.objects)) {
      throw new Error('Invalid search response: missing objects');
    }
    const packages = data.objects.map((item: unknown) => {
      if (!isRecord(item) || !isRecord(item.package)) throw new Error('Invalid package in search response');
      return namedPackage(item.package.name);
    });
    // Search total can mean current page length. Continue until an empty page.
    return { packages, count: packages.length, done: packages.length === 0 };
  });
  throw new Error('Search text=* cannot guarantee a complete package inventory; an empty search is not proof of an empty registry');
}

const adapters: ReadonlyArray<readonly [string, ListingAdapter]> = [
  ['/-/all', readLegacyMap],
  ['/_all_docs', readCouchDocuments],
  ['/-/verdaccio/data/packages', readVerdaccioPackages],
  ['/-/v1/search', readSearchResults],
];

/**
 * Enumerate advertised HTTP metadata, not locally stored tarballs.
 * A failure before the first valid page tries the next adapter. After a valid
 * page, retain its results and report the failure; never silently switch sources.
 * Without onError, incomplete listings fail closed for sync/prune callers.
 */
export async function listAllPackages(
  registryUrl: string,
  options: {
    scope?: string | null;
    authHeader?: string | null;
    onError?: (error: Error) => void;
  } = {}
): Promise<Map<string, PackageMetadata>> {
  const base = registryUrl.replace(/\/$/, '');
  const headers = options.authHeader ? { Authorization: options.authHeader } : {};
  const failures: string[] = [];

  for (const [endpoint, list] of adapters) {
    const packages = new Map<string, PackageMetadata>();
    let started = false;
    const read: ReadResponse = async (query = '') => {
      const url = `${base}${endpoint}${query}`;
      debug(`Trying endpoint: ${url}`);
      const response = await axios.get<unknown>(url, {
        headers, httpAgent, httpsAgent, timeout: TIMEOUTS.MAX,
        maxContentLength: 500 * 1024 * 1024,
        validateStatus: (status) => status === 200,
      });
      return response.data;
    };
    try {
      for await (const page of list(read)) {
        started = true;
        for (const pkg of page) {
          if (!options.scope || pkg.name.startsWith(`${options.scope}/`)) packages.set(pkg.name, pkg);
        }
      }
      return packages;
    } catch (error) {
      const message = `${endpoint}: ${(error as Error).message}`;
      if (started) {
        const incomplete = new Error(`Package listing incomplete (${message})`);
        if (!options.onError) throw incomplete;
        options.onError(incomplete);
        return packages;
      }
      failures.push(message);
      debug(message);
    }
  }
  throw new Error(`Could not list packages from registry ${registryUrl}: ${failures.join('; ')}`);
}
