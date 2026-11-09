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

function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

/** Full line range (inclusive start, exclusive end) of the dependency entry that starts at `line`. */
export function entryLineRange(doc: vscode.TextDocument, line: number): vscode.Range {
  const indent = indentOf(doc.lineAt(line).text);
  let end = line + 1;
  while (end < doc.lineCount) {
    const t = doc.lineAt(end).text;
    if (t.trim() && indentOf(t) <= indent) { break; }
    end++;
  }
  // don't swallow trailing blank lines
  while (end - 1 > line && !doc.lineAt(end - 1).text.trim()) { end--; }
  return new vscode.Range(line, 0, end, 0);
}

/** Returns edits that sort every dependency section alphabetically (sdk deps stay on top). */
export function sortEdits(doc: vscode.TextDocument): vscode.TextEdit[] {
  const edits: vscode.TextEdit[] = [];
  for (let i = 0; i < doc.lineCount; i++) {
    const top = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/.exec(doc.lineAt(i).text);
    if (!top || !DEPENDENCY_SECTIONS.includes(top[1])) { continue; }

    // collect body lines until the next top-level key
    let end = i + 1;
    while (end < doc.lineCount) {
      const t = doc.lineAt(end).text;
      if (t.trim() && !t.startsWith(' ') && !t.startsWith('\t') && !t.startsWith('#')) { break; }
      end++;
    }
    while (end - 1 > i && !doc.lineAt(end - 1).text.trim()) { end--; }

    interface Entry { name: string; sdk: boolean; lines: string[] }
    const entries: Entry[] = [];
    let pending: string[] = [];
    let depIndent: number | undefined;
    let firstLine: number | undefined;
    for (let j = i + 1; j < end; j++) {
      const t = doc.lineAt(j).text;
      const trimmed = t.trim();
      if (!trimmed) { continue; }
      if (trimmed.startsWith('#') && (depIndent === undefined || indentOf(t) <= depIndent)) {
        firstLine ??= j;
        pending.push(t);
        continue;
      }
      depIndent ??= indentOf(t);
      const key = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/.exec(t);
      if (indentOf(t) === depIndent && key) {
        firstLine ??= j;
        entries.push({ name: key[1], sdk: false, lines: [...pending, t] });
        pending = [];
      } else if (entries.length) {
        const e = entries[entries.length - 1];
        e.lines.push(t);
        if (/^\s+sdk\s*:/.test(t)) { e.sdk = true; }
      }
    }
    if (entries.length < 2 || firstLine === undefined) { continue; }
    const trailing = pending; // comments after the last entry stay at the end

    const sorted = [...entries].sort((a, b) => {
      if (a.sdk !== b.sdk) { return a.sdk ? -1 : 1; }
      return a.sdk ? 0 : a.name.localeCompare(b.name);
    });
    const newText = [...sorted.flatMap((e) => e.lines), ...trailing].join('\n') + '\n';
    const range = new vscode.Range(firstLine, 0, end, 0);
    if (doc.getText(range) !== newText) {
      edits.push(vscode.TextEdit.replace(range, newText));
    }
    i = end - 1;
  }
  return edits;
}

/** Top-level keys of the pubspec (packages like flutter_native_splash are configured this way). */
export function topLevelKeys(doc: vscode.TextDocument): Set<string> {
  const keys = new Set<string>();
  for (let i = 0; i < doc.lineCount; i++) {
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/.exec(doc.lineAt(i).text);
    if (m) { keys.add(m[1]); }
  }
  return keys;
}
