import { compareVersions, parseVersion, Version } from './semver';

export interface PackageInfo {
  name: string;
  latestStable?: string;
  latestAny?: string;
  description?: string;
  homepage?: string;
  repository?: string;
  discontinued?: boolean;
  /** All published versions, ascending. */
  versions: Version[];
}

const BASE = 'https://pub.dev/api';
const TTL_MS = 60 * 60 * 1000;
const headers = { Accept: 'application/vnd.pub.v2+json', 'User-Agent': 'flutter-pub-toolkit-vscode' };

const cache = new Map<string, { at: number; value: Promise<PackageInfo | undefined> }>();

export function clearCache(): void {
  cache.clear();
}

export function getPackage(name: string): Promise<PackageInfo | undefined> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.value;
  }
  const value = fetchPackage(name).catch(() => undefined);
  cache.set(name, { at: Date.now(), value });
  return value;
}

async function fetchPackage(name: string): Promise<PackageInfo | undefined> {
  const res = await fetch(`${BASE}/packages/${encodeURIComponent(name)}`, { headers });
  if (!res.ok) {
    return undefined;
  }
  const data: any = await res.json();
  const versions: string[] = (data.versions ?? []).map((v: any) => v.version);
  const parsed = versions.map(parseVersion).filter((v): v is NonNullable<typeof v> => !!v);
  parsed.sort(compareVersions);
  const stable = parsed.filter((v) => v.pre.length === 0);
  const latestPubspec = data.latest?.pubspec ?? {};
  return {
    name,
    latestStable: stable.length ? stable[stable.length - 1].raw : data.latest?.version,
    latestAny: parsed.length ? parsed[parsed.length - 1].raw : data.latest?.version,
    description: latestPubspec.description,
    homepage: latestPubspec.homepage,
    repository: latestPubspec.repository,
    discontinued: data.isDiscontinued === true,
    versions: parsed,
  };
}

export async function searchPackages(query: string): Promise<string[]> {
  if (!query) {
    return [];
  }
  try {
    const res = await fetch(`${BASE}/search?q=${encodeURIComponent(query)}`, { headers });
    if (!res.ok) {
      return [];
    }
    const data: any = await res.json();
    return (data.packages ?? []).map((p: any) => p.package as string);
  } catch {
    return [];
  }
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}
