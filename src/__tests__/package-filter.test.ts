import { describe, expect, it } from 'vitest';
import { createPackageExclusionMatcher } from '../core/package-filter.js';

describe('package exclusion rules', () => {
  const names = [
    '@esbuild/linux-x64', '@esbuild/linux-arm64', '@esbuild/darwin-arm64',
    '@libsql/linux-x64-musl', 'chalk',
  ];

  it('supports glob, braces and extglob against full, case-sensitive package names', () => {
    expect(names.filter(createPackageExclusionMatcher(['@esbuild/{darwin,win32}-*', '@libsql/*-musl'])))
      .toEqual(['@esbuild/darwin-arm64', '@libsql/linux-x64-musl']);
    expect(names.filter(createPackageExclusionMatcher(['@esbuild/@(darwin|win32)-*'])))
      .toEqual(['@esbuild/darwin-arm64']);
    expect(names.filter(createPackageExclusionMatcher(['@esbuild/!(linux-*)'])))
      .toEqual(['@esbuild/darwin-arm64']);
    expect(names.filter(createPackageExclusionMatcher(['*']))).toEqual(['chalk']);
    expect(names.filter(createPackageExclusionMatcher(['@esbuild/Darwin-*']))).toEqual([]);
  });

  it('gives keep exceptions priority regardless of position or repeated exclusions', () => {
    for (const rules of [
      ['@esbuild/*', '! @esbuild/linux-{x64,arm64}', '@esbuild/linux-x64'],
      ['! @esbuild/linux-{x64,arm64}', '@esbuild/linux-x64', '@esbuild/*'],
    ]) {
      expect(names.filter(createPackageExclusionMatcher(rules)))
        .toEqual(['@esbuild/darwin-arm64']);
    }
  });

  it('trims both configuration rules and keep patterns', () => {
    expect(names.filter(createPackageExclusionMatcher([' @esbuild/* ', ' !   @esbuild/linux-*  '])))
      .toEqual(['@esbuild/darwin-arm64']);
  });

  it('keeps Picomatch negation and leading extglob semantics when no space follows !', () => {
    const candidates = ['foo', 'bar', 'baz'];
    expect(candidates.filter(createPackageExclusionMatcher(['!(foo|bar)']))).toEqual(['baz']);
    expect(candidates.filter(createPackageExclusionMatcher(['!foo']))).toEqual(['bar', 'baz']);
    expect(candidates.filter(createPackageExclusionMatcher(['**', '! !(foo|bar)'])))
      .toEqual(['foo', 'bar']);
  });

  it('excludes nothing for empty rules or keep-only rules', () => {
    expect(names.filter(createPackageExclusionMatcher([]))).toEqual([]);
    expect(names.filter(createPackageExclusionMatcher(['! @esbuild/*']))).toEqual([]);
  });

  it.each(['!', '! ', ' !   '])('rejects a blank keep exception: %j', (rule) => {
    expect(() => createPackageExclusionMatcher([rule])).toThrow('requires a non-empty pattern');
  });
});
