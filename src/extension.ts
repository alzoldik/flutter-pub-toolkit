import * as path from 'path';
import * as vscode from 'vscode';
import { clearCache, getPackage, mapLimit, PackageInfo, searchPackages } from './pubApi';
import { Dependency, DEPENDENCY_SECTIONS, isPubspec, parseDependencies, sectionAt } from './pubspec';
import { bumpConstraint, compareVersions, constraintBaseVersion, parseVersion } from './semver';

const DIAG_SOURCE = 'flutter-pub-toolkit';
const OUTDATED_CODE = 'outdated';

interface OutdatedData {
  dep: Dependency;
  latest: string;
}

let diagnostics: vscode.DiagnosticCollection;
let latestDecoration: vscode.TextEditorDecorationType;
let outdatedDecoration: vscode.TextEditorDecorationType;
/** Per-document results of the last check, keyed by uri. */
const results = new Map<string, { outdated: OutdatedData[]; upToDate: Dependency[] }>();
const timers = new Map<string, NodeJS.Timeout>();

function config() {
  return vscode.workspace.getConfiguration('flutterPubToolkit');
}

function pickLatest(info: PackageInfo): string | undefined {
  return config().get<boolean>('includePrerelease') ? info.latestAny : info.latestStable;
}

function severity(): vscode.DiagnosticSeverity {
  switch (config().get<string>('severity')) {
    case 'error': return vscode.DiagnosticSeverity.Error;
    case 'information': return vscode.DiagnosticSeverity.Information;
    case 'hint': return vscode.DiagnosticSeverity.Hint;
    default: return vscode.DiagnosticSeverity.Warning;
  }
}

// ---------------------------------------------------------------------------
// Outdated dependency check
// ---------------------------------------------------------------------------

async function checkDocument(doc: vscode.TextDocument, showSummary = false): Promise<void> {
  if (!isPubspec(doc)) {
    return;
  }
  const ignored = new Set(config().get<string[]>('ignoredPackages') ?? []);
  const deps = parseDependencies(doc).filter((d) => !ignored.has(d.name));
  const version = doc.version;

  const infos = await mapLimit(deps, 8, (d) => getPackage(d.name));
  if (doc.version !== version) {
    return; // document changed while we were fetching; a newer check is scheduled
  }

  const diags: vscode.Diagnostic[] = [];
  const outdated: OutdatedData[] = [];
  const upToDate: Dependency[] = [];

  deps.forEach((dep, i) => {
    const info = infos[i];
    if (!info) {
      return;
    }
    if (info.discontinued) {
      const d = new vscode.Diagnostic(dep.nameRange, `Package "${dep.name}" is discontinued on pub.dev.`, vscode.DiagnosticSeverity.Warning);
      d.source = DIAG_SOURCE;
      diags.push(d);
    }
    const latestText = pickLatest(info);
    const latest = latestText ? parseVersion(latestText) : undefined;
    const current = constraintBaseVersion(dep.constraint);
    if (!latest || !current) {
      return;
    }
    if (compareVersions(latest, current) > 0) {
      const d = new vscode.Diagnostic(
        dep.constraintRange,
        `A newer version of "${dep.name}" is available: ${latest.raw} (current: ${dep.constraint})`,
        severity(),
      );
      d.source = DIAG_SOURCE;
      d.code = OUTDATED_CODE;
      diags.push(d);
      outdated.push({ dep, latest: latest.raw });
    } else {
      upToDate.push(dep);
    }
  });

  diagnostics.set(doc.uri, diags);
  results.set(doc.uri.toString(), { outdated, upToDate });
  refreshDecorations();

  if (showSummary) {
    const msg = outdated.length
      ? `${outdated.length} of ${deps.length} dependencies can be updated.`
      : `All ${deps.length} dependencies are up to date.`;
    const action = outdated.length ? await vscode.window.showInformationMessage(msg, 'Update All') : (vscode.window.showInformationMessage(msg), undefined);
    if (action === 'Update All') {
      await updateAll(doc);
    }
  }
}

function scheduleCheck(doc: vscode.TextDocument, delay = 800): void {
  if (!isPubspec(doc) || !config().get<boolean>('checkOnOpen')) {
    return;
  }
  const key = doc.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    void checkDocument(doc);
  }, delay));
}

function refreshDecorations(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    const r = results.get(editor.document.uri.toString());
    if (!r) {
      continue;
    }
    editor.setDecorations(outdatedDecoration, r.outdated.map((o) => ({
      range: new vscode.Range(o.dep.constraintRange.end, o.dep.constraintRange.end),
      renderOptions: { after: { contentText: `  → ${o.latest}` } },
    })));
    editor.setDecorations(latestDecoration, r.upToDate.map((d) => ({
      range: new vscode.Range(d.constraintRange.end, d.constraintRange.end),
      renderOptions: { after: { contentText: '  ✓' } },
    })));
  }
}

async function updateAll(doc: vscode.TextDocument): Promise<void> {
  await checkDocument(doc);
  const r = results.get(doc.uri.toString());
  if (!r || !r.outdated.length) {
    vscode.window.showInformationMessage('All dependencies are already up to date.');
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  for (const o of r.outdated) {
    edit.replace(doc.uri, o.dep.constraintRange, bumpConstraint(o.dep.constraint, o.latest));
  }
  await vscode.workspace.applyEdit(edit);
  vscode.window.showInformationMessage(`Updated ${r.outdated.length} dependencies. Run "Pub Get" to fetch them.`, 'Pub Get')
    .then((a) => { if (a) { runInTerminal(doc.uri, 'pub get'); } });
}

// ---------------------------------------------------------------------------
// Quick fixes
// ---------------------------------------------------------------------------

class UpdateCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const r = results.get(doc.uri.toString());
    if (!r) {
      return [];
    }
    const actions: vscode.CodeAction[] = [];
    for (const diag of ctx.diagnostics) {
      if (diag.source !== DIAG_SOURCE || diag.code !== OUTDATED_CODE) {
        continue;
      }
      const o = r.outdated.find((x) => x.dep.constraintRange.isEqual(diag.range));
      if (!o) {
        continue;
      }
      const newText = bumpConstraint(o.dep.constraint, o.latest);
      const fix = new vscode.CodeAction(`Update ${o.dep.name} to ${newText}`, vscode.CodeActionKind.QuickFix);
      fix.edit = new vscode.WorkspaceEdit();
      fix.edit.replace(doc.uri, o.dep.constraintRange, newText);
      fix.diagnostics = [diag];
      fix.isPreferred = true;
      actions.push(fix);
    }
    if (actions.length && r.outdated.length > 1) {
      const all = new vscode.CodeAction(`Update all ${r.outdated.length} outdated dependencies`, vscode.CodeActionKind.QuickFix);
      all.command = { command: 'flutterPubToolkit.updateAll', title: 'Update all' };
      actions.push(all);
    }
    return actions;
  }
}

// ---------------------------------------------------------------------------
// Hover & completion
// ---------------------------------------------------------------------------

class PackageHover implements vscode.HoverProvider {
  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const dep = parseDependencies(doc).find((d) => d.nameRange.contains(pos) || d.constraintRange.contains(pos));
    if (!dep) {
      return undefined;
    }
    const info = await getPackage(dep.name);
    if (!info) {
      return undefined;
    }
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**[${info.name}](https://pub.dev/packages/${info.name})**`);
    if (info.latestStable) { md.appendMarkdown(` — latest \`${info.latestStable}\``); }
    if (info.latestAny && info.latestAny !== info.latestStable) { md.appendMarkdown(` (prerelease \`${info.latestAny}\`)`); }
    md.appendMarkdown('\n\n');
    if (info.discontinued) { md.appendMarkdown('⚠️ **Discontinued**\n\n'); }
    if (info.description) { md.appendText(info.description); md.appendMarkdown('\n\n'); }
    const links = [`[Changelog](https://pub.dev/packages/${info.name}/changelog)`, `[Versions](https://pub.dev/packages/${info.name}/versions)`];
    if (info.repository || info.homepage) { links.push(`[Repository](${info.repository ?? info.homepage})`); }
    md.appendMarkdown(links.join(' · '));
    return new vscode.Hover(md, dep.nameRange);
  }
}

class PackageCompletion implements vscode.CompletionItemProvider {
  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    const section = sectionAt(doc, pos.line);
    if (!section || !DEPENDENCY_SECTIONS.includes(section)) {
      return undefined;
    }
    const before = doc.lineAt(pos.line).text.slice(0, pos.character);

    // `  package_name: |` -> suggest the latest version
    const versionCtx = /^\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*\^?$/.exec(before);
    if (versionCtx) {
      const info = await getPackage(versionCtx[1]);
      const latest = info && pickLatest(info);
      if (!latest) { return undefined; }
      const hasCaret = before.trimEnd().endsWith('^');
      const item = new vscode.CompletionItem(hasCaret ? latest : `^${latest}`, vscode.CompletionItemKind.Value);
      item.detail = `latest version of ${versionCtx[1]}`;
      item.sortText = '0';
      return [item];
    }

    // `  partial_na|` -> search pub.dev
    const nameCtx = /^\s+([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(before);
    if (!nameCtx || nameCtx[1].length < 2) {
      return undefined;
    }
    const names = await searchPackages(nameCtx[1]);
    const range = new vscode.Range(pos.line, pos.character - nameCtx[1].length, pos.line, pos.character);
    return Promise.all(names.slice(0, 15).map(async (name, i) => {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Module);
      item.range = range;
      item.sortText = String(i).padStart(3, '0');
      item.filterText = nameCtx[1] + ' ' + name; // keep pub.dev ranking, don't let VS Code filter it out
      const info = await getPackage(name);
      const latest = info && pickLatest(info);
      item.insertText = latest ? `${name}: ^${latest}` : `${name}: `;
      item.detail = latest ? `^${latest}` : undefined;
      item.documentation = info?.description;
      return item;
    }));
  }
}

// ---------------------------------------------------------------------------
// Terminal commands
// ---------------------------------------------------------------------------

async function projectDir(uri?: vscode.Uri): Promise<string | undefined> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (target && target.scheme === 'file') {
    // walk up to the nearest pubspec.yaml
    let dir = path.dirname(target.fsPath);
    if (path.basename(target.fsPath) === 'pubspec.yaml') { return dir; }
    while (dir !== path.dirname(dir)) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(path.join(dir, 'pubspec.yaml')));
        return dir;
      } catch { dir = path.dirname(dir); }
    }
  }
  const found = await vscode.workspace.findFiles('**/pubspec.yaml', '**/{.dart_tool,build,ios,android}/**', 20);
  if (!found.length) {
    vscode.window.showErrorMessage('No pubspec.yaml found in this workspace.');
    return undefined;
  }
  if (found.length === 1) { return path.dirname(found[0].fsPath); }
  const pick = await vscode.window.showQuickPick(found.map((f) => vscode.workspace.asRelativePath(path.dirname(f.fsPath))), { placeHolder: 'Select a Flutter/Dart project' });
  const match = found.find((f) => vscode.workspace.asRelativePath(path.dirname(f.fsPath)) === pick);
  return match && path.dirname(match.fsPath);
}

async function isFlutterProject(dir: string): Promise<boolean> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(dir, 'pubspec.yaml')));
    return /sdk:\s*flutter/.test(Buffer.from(bytes).toString('utf8'));
  } catch { return true; }
}

async function runInTerminal(uri: vscode.Uri | undefined, args: string, name = 'Flutter Pub Toolkit'): Promise<void> {
  const dir = await projectDir(uri);
  if (!dir) { return; }
  const tool = (await isFlutterProject(dir)) ? 'flutter' : 'dart';
  const prefix = config().get<boolean>('useFvm') ? 'fvm ' : '';
  const term = vscode.window.terminals.find((t) => t.name === name) ?? vscode.window.createTerminal({ name, cwd: dir });
  term.show();
  term.sendText(`cd "${dir}" && ${args.split(' && ').map((a) => `${prefix}${a.startsWith('dart ') ? a : `${tool} ${a}`}`).join(' && ')}`);
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  diagnostics = vscode.languages.createDiagnosticCollection(DIAG_SOURCE);
  latestDecoration = vscode.window.createTextEditorDecorationType({ after: { color: new vscode.ThemeColor('editorCodeLens.foreground') } });
  outdatedDecoration = vscode.window.createTextEditorDecorationType({ after: { color: new vscode.ThemeColor('editorWarning.foreground') } });

  const selector: vscode.DocumentSelector = [
    { language: 'yaml', pattern: '**/pubspec.yaml' },
    { scheme: 'file', pattern: '**/pubspec.yaml' },
  ];

  const pubspecFromArg = (uri?: vscode.Uri) => {
    const doc = uri ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) : vscode.window.activeTextEditor?.document;
    return doc && isPubspec(doc) ? Promise.resolve(doc) : projectDir(uri).then((dir) => dir ? vscode.workspace.openTextDocument(path.join(dir, 'pubspec.yaml')) : undefined);
  };

  context.subscriptions.push(
    diagnostics,
    latestDecoration,
    outdatedDecoration,
    vscode.languages.registerCodeActionsProvider(selector, new UpdateCodeActions(), { providedCodeActionKinds: UpdateCodeActions.kinds }),
    vscode.languages.registerHoverProvider(selector, new PackageHover()),
    vscode.languages.registerCompletionItemProvider(selector, new PackageCompletion(), ':', ' ', '^'),

    vscode.workspace.onDidOpenTextDocument((d) => scheduleCheck(d, 0)),
    vscode.workspace.onDidSaveTextDocument((d) => scheduleCheck(d, 0)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isPubspec(e.document)) {
        results.delete(e.document.uri.toString());
        scheduleCheck(e.document);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((d) => { diagnostics.delete(d.uri); results.delete(d.uri.toString()); }),
    vscode.window.onDidChangeVisibleTextEditors(refreshDecorations),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('flutterPubToolkit')) {
        vscode.workspace.textDocuments.forEach((d) => scheduleCheck(d, 0));
      }
    }),

    vscode.commands.registerCommand('flutterPubToolkit.checkUpdates', async (uri?: vscode.Uri) => {
      clearCache();
      const doc = await pubspecFromArg(uri);
      if (doc) {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Checking pub.dev…' }, () => checkDocument(doc, true));
      }
    }),
    vscode.commands.registerCommand('flutterPubToolkit.updateAll', async (uri?: vscode.Uri) => {
      const doc = await pubspecFromArg(uri);
      if (doc) { await updateAll(doc); }
    }),
    vscode.commands.registerCommand('flutterPubToolkit.pubGet', (uri?: vscode.Uri) => runInTerminal(uri, 'pub get')),
    vscode.commands.registerCommand('flutterPubToolkit.pubUpgrade', (uri?: vscode.Uri) => runInTerminal(uri, 'pub upgrade')),
    vscode.commands.registerCommand('flutterPubToolkit.buildRunnerBuild', (uri?: vscode.Uri) => runInTerminal(uri, 'dart run build_runner build --delete-conflicting-outputs')),
    vscode.commands.registerCommand('flutterPubToolkit.buildRunnerWatch', (uri?: vscode.Uri) => runInTerminal(uri, 'dart run build_runner watch --delete-conflicting-outputs', 'build_runner watch')),
    vscode.commands.registerCommand('flutterPubToolkit.buildRunnerClean', (uri?: vscode.Uri) => runInTerminal(uri, 'dart run build_runner clean')),
    vscode.commands.registerCommand('flutterPubToolkit.flutterClean', (uri?: vscode.Uri) => runInTerminal(uri, 'clean && pub get')),
  );

  vscode.workspace.textDocuments.forEach((d) => scheduleCheck(d, 0));
}

export function deactivate(): void {
  timers.forEach((t) => clearTimeout(t));
}
