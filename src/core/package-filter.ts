/** Package-name glob matching with explicit keep exceptions. */
import picomatch from 'picomatch';

export function createPackageExclusionMatcher(rules: string[]): (name: string) => boolean {
  if (
    !Array.isArray(rules) ||
    rules.some((rule) => typeof rule !== 'string' || rule.trim().length === 0)
  ) {
    throw new Error('excludePackages must be an array of non-empty strings');
  }

  const exclude: string[] = [];
  const keep: string[] = [];
  for (const rule of rules) {
    const pattern = rule.trim();
    // Trimming a blank "! " exception leaves "!"; reject that too.
    if (pattern === '!') {
      throw new Error('Keep exception "! " requires a non-empty pattern');
    }
    if (pattern.startsWith('! ')) {
      keep.push(pattern.slice(2).trim());
    } else {
      exclude.push(pattern);
    }
  }

  // Compile once. Package scopes always use POSIX slashes, including on Windows.
  return picomatch(exclude, { ignore: keep, windows: false });
}
