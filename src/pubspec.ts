import * as vscode from 'vscode';

export const DEPENDENCY_SECTIONS = ['dependencies', 'dev_dependencies', 'dependency_overrides'];

export interface Dependency {
  name: string;
  /** Raw constraint text exactly as written, e.g. `^1.2.3` or `"1.0.0"`. */
  constraint: string;
  section: string;
  nameRange: vscode.Range;
  constraintRange: vscode.Range;
}

// `  package_name: ^1.2.3   # comment`
const DEP_LINE = /^(\s+)([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(['"]?[^\s#'"][^#]*?['"]?)\s*(#.*)?$/;
// `  package_name:` followed by nested `version: ^1.2.3` (hosted dependency)
const DEP_HEADER = /^(\s+)([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(#.*)?$/;
const NESTED_VERSION = /^(\s+)version\s*:\s*(['"]?[^\s#'"]+['"]?)/;

/** Returns the top-level section a 0-indexed line belongs to, or undefined. */
export function sectionAt(doc: vscode.TextDocument, line: number): string | undefined {
  for (let i = line; i >= 0; i--) {
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/.exec(doc.lineAt(i).text);
    if (m) {
      return m[1];
    }
  }
  return undefined;
}

export function parseDependencies(doc: vscode.TextDocument): Dependency[] {
  const deps: Dependency[] = [];
  let section: string | undefined;
  let depIndent: number | undefined;

  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    if (!text.trim() || text.trim().startsWith('#')) {
      continue;
    }
    const top = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/.exec(text);
    if (top) {
      section = DEPENDENCY_SECTIONS.includes(top[1]) ? top[1] : undefined;
      depIndent = undefined;
      continue;
    }
    if (!section) {
      continue;
    }
    const indent = text.length - text.trimStart().length;
    if (depIndent === undefined) {
      depIndent = indent;
    }
    if (indent !== depIndent) {
      continue;
    }

    const line = DEP_LINE.exec(text);
    if (line) {
      const name = line[2];
      const constraint = line[3].trim();
      if (name === 'flutter' || name === 'flutter_test' || !/\d/.test(constraint)) {
        continue;
      }
      const nameStart = line[1].length;
      const cStart = text.indexOf(constraint, nameStart + name.length + 1);
      deps.push({
        name,
        constraint,
        section,
        nameRange: new vscode.Range(i, nameStart, i, nameStart + name.length),
        constraintRange: new vscode.Range(i, cStart, i, cStart + constraint.length),
      });
      continue;
    }

    const header = DEP_HEADER.exec(text);
    if (header) {
      // Look at nested keys: only hosted deps (with `version:` and no git/path/sdk) are checked.
      let version: { text: string; line: number; col: number } | undefined;
      let other = false;
      for (let j = i + 1; j < doc.lineCount; j++) {
        const t = doc.lineAt(j).text;
        if (!t.trim()) { continue; }
        if (t.length - t.trimStart().length <= indent) { break; }
        const nv = NESTED_VERSION.exec(t);
        if (nv) {
          version = { text: nv[2], line: j, col: t.indexOf(nv[2], nv[1].length + 7) };
        } else if (/^\s+(git|path|sdk)\s*:/.test(t)) {
          other = true;
        }
      }
      if (version && !other) {
        const nameStart = header[1].length;
        deps.push({
          name: header[2],
          constraint: version.text,
          section,
          nameRange: new vscode.Range(i, nameStart, i, nameStart + header[2].length),
          constraintRange: new vscode.Range(version.line, version.col, version.line, version.col + version.text.length),
        });
      }
    }
  }
  return deps;
}

export function isPubspec(doc: vscode.TextDocument): boolean {
  return doc.uri.path.endsWith('/pubspec.yaml');
}
