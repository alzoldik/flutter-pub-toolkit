export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
  raw: string;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text: string): Version | undefined {
  const m = VERSION_RE.exec(text.trim());
  if (!m) {
    return undefined;
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
    raw: text.trim(),
  };
}

export function compareVersions(a: Version, b: Version): number {
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (a[k] !== b[k]) {
      return a[k] - b[k];
    }
  }
  // A version without prerelease is greater than one with prerelease.
  if (!a.pre.length && b.pre.length) { return 1; }
  if (a.pre.length && !b.pre.length) { return -1; }
  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) { return -1; }
    if (y === undefined) { return 1; }
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) { return d; }
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Extracts the "base" version a constraint was written against.
 * `^1.2.3` -> 1.2.3, `>=1.0.0 <2.0.0` -> 1.0.0, `1.2.3` -> 1.2.3, `any` -> undefined.
 */
export function constraintBaseVersion(constraint: string): Version | undefined {
  const c = constraint.trim().replace(/^['"]|['"]$/g, '');
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(c);
  return m ? parseVersion(m[1]) : undefined;
}

/** Builds a replacement constraint that keeps the user's style (caret / exact / quoted). */
export function bumpConstraint(constraint: string, latest: string): string {
  const quote = /^['"]/.exec(constraint)?.[0] ?? '';
  const inner = constraint.replace(/^['"]|['"]$/g, '').trim();
  if (inner.startsWith('^')) { return `${quote}^${latest}${quote}`; }
  if (/^\d/.test(inner)) { return `${quote}${latest}${quote}`; }
  // Ranges like ">=1.0.0 <2.0.0" are replaced by a caret constraint.
  return `${quote}^${latest}${quote}`;
}
