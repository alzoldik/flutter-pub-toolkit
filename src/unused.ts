import { promises as fs } from 'fs';
import * as vscode from 'vscode';

/** Packages that are legitimately listed under `dependencies` without being imported. */
export const NEVER_IMPORTED = new Set([
  'cupertino_icons', 'flutter_launcher_icons', 'flutter_native_splash', 'flutter_lints', 'lints',
  'build_runner', 'intl_utils', 'flutter_dotenv', 'google_fonts',
]);

const cache = new Map<string, Promise<Set<string>>>();

export function invalidateImports(): void {
  cache.clear();
}

/** Every package referenced via `package:<name>/` in the project's Dart sources. */
export function importedPackages(projectDir: string): Promise<Set<string>> {
  let hit = cache.get(projectDir);
  if (!hit) {
    hit = scan(projectDir);
    cache.set(projectDir, hit);
  }
  return hit;
}

async function scan(projectDir: string): Promise<Set<string>> {
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(projectDir, '{lib,bin,test,integration_test,test_driver,tool}/**/*.dart'),
    undefined,
    20000,
  );
  const found = new Set<string>();
  const re = /['"]package:([a-zA-Z0-9_]+)\//g;
  await Promise.all(files.map(async (f) => {
    try {
      const text = await fs.readFile(f.fsPath, 'utf8');
      for (const m of text.matchAll(re)) { found.add(m[1]); }
    } catch { /* ignore unreadable files */ }
  }));
  return found;
}
