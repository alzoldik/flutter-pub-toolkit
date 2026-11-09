import { promises as fs } from 'fs';
import * as vscode from 'vscode';

/** Packages that are legitimately listed under `dependencies` without being imported. */
export const NEVER_IMPORTED = new Set([
  'cupertino_icons', 'flutter_launcher_icons', 'flutter_native_splash', 'flutter_lints', 'lints',
  'very_good_analysis', 'pedantic', 'effective_dart', 'build_runner', 'intl_utils', 'flutter_dotenv',
  'google_fonts', 'flutter_gen_runner', 'flutter_gen', 'build_verify', 'dart_code_metrics', 'custom_lint',
  'riverpod_lint', 'change_app_package_name', 'rename', 'msix', 'flutter_flavorizr', 'import_sorter',
]);

/** Code generators / builders that run via build_runner and are never imported directly. */
const GENERATOR_RE = /(_generator|_builder|_gen|_codegen|_lint|_lints)$/;
const KNOWN_GENERATORS = new Set([
  'freezed', 'json_serializable', 'retrofit_generator', 'hive_generator', 'injectable_generator',
  'auto_route_generator', 'mobx_codegen', 'built_value_generator', 'drift_dev', 'moor_generator',
  'isar_generator', 'riverpod_generator', 'envied_generator', 'go_router_builder', 'slang_build_runner',
  'easy_localization_generator', 'pigeon', 'ffigen', 'flutter_oss_licenses',
]);

/** True if a package is expected to be listed without any `import 'package:<name>/...'`. */
export function isToolPackage(name: string, section: string): boolean {
  if (NEVER_IMPORTED.has(name)) { return true; }
  if (section === 'dev_dependencies' && (GENERATOR_RE.test(name) || KNOWN_GENERATORS.has(name))) { return true; }
  return false;
}

/** package name -> files (fsPath) that reference `package:<name>/`. */
export type ImportIndex = Map<string, string[]>;

const cache = new Map<string, Promise<ImportIndex>>();

export function invalidateImports(): void {
  cache.clear();
}

/** Every package referenced via `package:<name>/` in the project's Dart sources. */
export function importedPackages(projectDir: string): Promise<ImportIndex> {
  let hit = cache.get(projectDir);
  if (!hit) {
    hit = scan(projectDir);
    cache.set(projectDir, hit);
  }
  return hit;
}

async function scan(projectDir: string): Promise<ImportIndex> {
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(projectDir, '{lib,bin,test,integration_test,test_driver,tool,example/lib}/**/*.dart'),
    undefined,
    20000,
  );
  const index: ImportIndex = new Map();
  const re = /['"]package:([a-zA-Z0-9_]+)\//g;
  await Promise.all(files.map(async (f) => {
    try {
      const text = await fs.readFile(f.fsPath, 'utf8');
      const seen = new Set<string>();
      for (const m of text.matchAll(re)) { seen.add(m[1]); }
      for (const name of seen) {
        const list = index.get(name);
        if (list) { list.push(f.fsPath); } else { index.set(name, [f.fsPath]); }
      }
    } catch { /* ignore unreadable files */ }
  }));
  return index;
}
