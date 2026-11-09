import * as path from 'path';
import * as vscode from 'vscode';
import { generateAssetsFile } from './assets';
import { clearCache, getPackage, mapLimit, PackageInfo, searchPackages } from './pubApi';
import { Dependency, DEPENDENCY_SECTIONS, entryLineRange, isPubspec, parseDependencies, sectionAt, sortEdits, topLevelKeys } from './pubspec';
import { bumpConstraint, compareVersions, constraintBaseVersion, isBreaking, latestCompatible, parseVersion } from './semver';
import { importedPackages, invalidateImports, NEVER_IMPORTED } from './unused';

const DIAG_SOURCE = 'flutter-pub-toolkit';
const OUTDATED_CODE = 'outdated';
const UNUSED_CODE = 'unused';

interface OutdatedData {
  dep: Dependency;
  latest: string;
  /** Newest version that is not a breaking change, if different from `latest`. */
  compatible?: string;
  breaking: boolean;
}

interface CheckResult {
  outdated: OutdatedData[];
  upToDate: Dependency[];
  unused: Dependency[];
}

let diagnostics: vscode.DiagnosticCollection;
let latestDecoration: vscode.TextEditorDecorationType;
let outdatedDecoration: vscode.TextEditorDecorationType;
let statusItem: vscode.StatusBarItem;
const codeLensChanged = new vscode.EventEmitter<void>();
/** Per-document results of the last check, keyed by uri. */
const results = new Map<string, CheckResult>();
const checking = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();

function config() {
  return vscode.workspace.getConfiguration('flutterPubToolkit');
}

function includePre(): boolean {
  return config().get<boolean>('includePrerelease') ?? false;
}

function pickLatest(info: PackageInfo): string | undefined {
  return includePre() ? info.latestAny : info.latestStable;
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
// Dependency check (outdated + unused)
// ---------------------------------------------------------------------------

async function checkDocument(doc: vscode.TextDocument, showSummary = false): Promise<void> {
  if (!isPubspec(doc)) {
    return;
  }
  const key = doc.uri.toString();
  const ignored = new Set(config().get<string[]>('ignoredPackages') ?? []);
  const deps = parseDependencies(doc).filter((d) => !ignored.has(d.name));
  const version = doc.version;

  checking.add(key);
  updateStatus();
  codeLensChanged.fire();
  let infos: (PackageInfo | undefined)[];
  let imported: Set<string> | undefined;
  try {
    [infos, imported] = await Promise.all([
      mapLimit(deps, 8, (d) => getPackage(d.name)),
      config().get<boolean>('detectUnused') && doc.uri.scheme === 'file'
        ? importedPackages(path.dirname(doc.uri.fsPath))
        : Promise.resolve(undefined),
    ]);
  } finally {
    checking.delete(key);
  }
  if (doc.version !== version) {
    return; // document changed while we were fetching; a newer check is scheduled
  }

  const diags: vscode.Diagnostic[] = [];
  const result: CheckResult = { outdated: [], upToDate: [], unused: [] };
  const configuredAtTop = topLevelKeys(doc);

  deps.forEach((dep, i) => {
    // --- unused
    if (imported && dep.section === 'dependencies' && !imported.has(dep.name)
      && !NEVER_IMPORTED.has(dep.name) && !configuredAtTop.has(dep.name)) {
      const d = new vscode.Diagnostic(dep.nameRange,
        `"${dep.name}" is not imported anywhere in lib/, bin/ or test/. It may be unused.`,
        vscode.DiagnosticSeverity.Hint);
      d.source = DIAG_SOURCE;
      d.code = UNUSED_CODE;
      d.tags = [vscode.DiagnosticTag.Unnecessary];
      diags.push(d);
      result.unused.push(dep);
    }

    // --- outdated / discontinued
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
      const breaking = isBreaking(current, latest);
      const compat = breaking ? latestCompatible(info.versions, current, includePre()) : undefined;
      const msg = breaking
        ? `"${dep.name}" ${latest.raw} is available (major update, may contain breaking changes).`
          + (compat ? ` Safe update: ${compat.raw}.` : '')
        : `A newer version of "${dep.name}" is available: ${latest.raw}`;
      const d = new vscode.Diagnostic(dep.constraintRange, `${msg} (current: ${dep.constraint})`, severity());
      d.source = DIAG_SOURCE;
      d.code = OUTDATED_CODE;
      diags.push(d);
      result.outdated.push({ dep, latest: latest.raw, compatible: compat?.raw, breaking });
    } else {
      result.upToDate.push(dep);
    }
  });

  diagnostics.set(doc.uri, diags);
  results.set(key, result);
  refreshDecorations();
  updateStatus();
  codeLensChanged.fire();

  if (showSummary) {
    const n = result.outdated.length;
    const major = result.outdated.filter((o) => o.breaking).length;
    const msg = n
      ? `${n} of ${deps.length} dependencies can be updated${major ? ` (${major} major)` : ''}.`
      : `All ${deps.length} dependencies are up to date.`;
    const actions = n ? (major ? ['Update All', 'Update Safe Only'] : ['Update All']) : [];
    const action = await vscode.window.showInformationMessage(msg, ...actions);
    if (action) {
      await updateAll(doc, action === 'Update Safe Only');
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
      editor.setDecorations(outdatedDecoration, []);
      editor.setDecorations(latestDecoration, []);
      continue;
    }
    editor.setDecorations(outdatedDecoration, r.outdated.map((o) => ({
      range: new vscode.Range(o.dep.constraintRange.end, o.dep.constraintRange.end),
      renderOptions: { after: { contentText: `  → ${o.latest}${o.breaking ? ' (major)' : ''}` } },
    })));
    editor.setDecorations(latestDecoration, r.upToDate.map((d) => ({
      range: new vscode.Range(d.constraintRange.end, d.constraintRange.end),
      renderOptions: { after: { contentText: '  ✓' } },
    })));
  }
}

function updateStatus(): void {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || !isPubspec(doc)) {
    statusItem.hide();
    return;
  }
  const key = doc.uri.toString();
  const r = results.get(key);
  if (checking.has(key)) {
    statusItem.text = '$(sync~spin) pub.dev';
    statusItem.tooltip = 'Checking pub.dev for updates…';
  } else if (!r) {
    statusItem.text = '$(package) pub.dev';
    statusItem.tooltip = 'Check for package updates';
  } else if (r.outdated.length) {
    statusItem.text = `$(arrow-up) ${r.outdated.length} outdated`;
    statusItem.tooltip = r.outdated.map((o) => `${o.dep.name}: ${o.dep.constraint} → ${o.latest}`).join('\n');
  } else {
    statusItem.text = '$(check) deps up to date';
    statusItem.tooltip = 'All dependencies are on the latest version';
  }
  statusItem.show();
}

async function updateAll(doc: vscode.TextDocument, safeOnly = false): Promise<void> {
  await checkDocument(doc);
  const r = results.get(doc.uri.toString());
  const targets = (r?.outdated ?? [])
    .map((o) => ({ o, to: safeOnly && o.breaking ? o.compatible : o.latest }))
    .filter((x): x is { o: OutdatedData; to: string } => !!x.to);
  if (!targets.length) {
    vscode.window.showInformationMessage(safeOnly ? 'No safe (non-breaking) updates available.' : 'All dependencies are already up to date.');
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  for (const { o, to } of targets) {
    edit.replace(doc.uri, o.dep.constraintRange, bumpConstraint(o.dep.constraint, to));
  }
  await vscode.workspace.applyEdit(edit);
  await afterUpdate(doc, `Updated ${targets.length} dependencies.`);
}

async function afterUpdate(doc: vscode.TextDocument, message: string): Promise<void> {
  if (config().get<boolean>('runPubGetAfterUpdate')) {
    await doc.save();
    await runInTerminal(doc.uri, 'pub get');
    return;
  }
  const a = await vscode.window.showInformationMessage(`${message} Run "pub get" to fetch them.`, 'Save & Pub Get');
  if (a) {
    await doc.save();
    await runInTerminal(doc.uri, 'pub get');
  }
}

async function sortDocument(doc: vscode.TextDocument): Promise<void> {
  const edits = sortEdits(doc);
  if (!edits.length) {
    vscode.window.showInformationMessage('Dependencies are already sorted.');
    return;
  }
  const we = new vscode.WorkspaceEdit();
  we.set(doc.uri, edits);
  await vscode.workspace.applyEdit(we);
}

// ---------------------------------------------------------------------------
// Quick fixes
// ---------------------------------------------------------------------------

class PubspecCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const r = results.get(doc.uri.toString());
    if (!r) {
      return [];
    }
    const actions: vscode.CodeAction[] = [];
    for (const diag of ctx.diagnostics) {
      if (diag.source !== DIAG_SOURCE) {
        continue;
      }
      if (diag.code === OUTDATED_CODE) {
        const o = r.outdated.find((x) => x.dep.constraintRange.isEqual(diag.range));
        if (!o) { continue; }
        const replace = (title: string, version: string, preferred: boolean) => {
          const fix = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
          fix.edit = new vscode.WorkspaceEdit();
          fix.edit.replace(doc.uri, o.dep.constraintRange, bumpConstraint(o.dep.constraint, version));
          fix.diagnostics = [diag];
          fix.isPreferred = preferred;
          actions.push(fix);
        };
        if (o.compatible) {
          replace(`Update ${o.dep.name} to ${bumpConstraint(o.dep.constraint, o.compatible)} (safe)`, o.compatible, true);
        }
        replace(`Update ${o.dep.name} to ${bumpConstraint(o.dep.constraint, o.latest)}${o.breaking ? ' (major, breaking)' : ''}`, o.latest, !o.compatible);
        const log = new vscode.CodeAction(`Open ${o.dep.name} changelog`, vscode.CodeActionKind.QuickFix);
        log.command = { command: 'vscode.open', title: 'Open changelog', arguments: [vscode.Uri.parse(`https://pub.dev/packages/${o.dep.name}/changelog`)] };
        actions.push(log);
      } else if (diag.code === UNUSED_CODE) {
        const dep = r.unused.find((x) => x.nameRange.isEqual(diag.range));
        if (!dep) { continue; }
        const rm = new vscode.CodeAction(`Remove dependency "${dep.name}"`, vscode.CodeActionKind.QuickFix);
        rm.edit = new vscode.WorkspaceEdit();
        rm.edit.delete(doc.uri, entryLineRange(doc, dep.nameRange.start.line));
        rm.diagnostics = [diag];
        actions.push(rm);
        const ignore = new vscode.CodeAction(`Ignore "${dep.name}" in Flutter Pub Toolkit`, vscode.CodeActionKind.QuickFix);
        ignore.command = { command: 'flutterPubToolkit.ignorePackage', title: 'Ignore', arguments: [dep.name] };
        actions.push(ignore);
      }
    }
    if (actions.length && r.outdated.length > 1) {
      const all = new vscode.CodeAction(`Update all ${r.outdated.length} outdated dependencies`, vscode.CodeActionKind.QuickFix);
      all.command = { command: 'flutterPubToolkit.updateAll', title: 'Update all' };
      actions.push(all);
      if (r.outdated.some((o) => o.breaking)) {
        const safe = new vscode.CodeAction('Update all dependencies (safe, non-breaking only)', vscode.CodeActionKind.QuickFix);
        safe.command = { command: 'flutterPubToolkit.updateAllSafe', title: 'Update safe' };
        actions.push(safe);
      }
    }
    return actions;
  }
}

// ---------------------------------------------------------------------------
// CodeLens above `dependencies:`
// ---------------------------------------------------------------------------

class PubspecCodeLens implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses = codeLensChanged.event;

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    let line = -1;
    for (let i = 0; i < doc.lineCount; i++) {
      const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/.exec(doc.lineAt(i).text);
      if (m && DEPENDENCY_SECTIONS.includes(m[1])) { line = i; break; }
    }
    if (line < 0) { return []; }
    const range = new vscode.Range(line, 0, line, 0);
    const key = doc.uri.toString();
    const r = results.get(key);
    const lenses: vscode.CodeLens[] = [];
    if (checking.has(key)) {
      lenses.push(new vscode.CodeLens(range, { title: '$(sync~spin) Checking pub.dev…', command: '' }));
    } else if (r && r.outdated.length) {
      lenses.push(new vscode.CodeLens(range, { title: `$(arrow-up) Update all (${r.outdated.length})`, command: 'flutterPubToolkit.updateAll' }));
      if (r.outdated.some((o) => o.breaking)) {
        lenses.push(new vscode.CodeLens(range, { title: 'Update safe only', command: 'flutterPubToolkit.updateAllSafe' }));
      }
    } else if (r) {
      lenses.push(new vscode.CodeLens(range, { title: '$(check) All up to date', command: 'flutterPubToolkit.checkUpdates' }));
    } else {
      lenses.push(new vscode.CodeLens(range, { title: '$(search) Check updates', command: 'flutterPubToolkit.checkUpdates' }));
    }
    lenses.push(new vscode.CodeLens(range, { title: 'Pub get', command: 'flutterPubToolkit.pubGet', arguments: [doc.uri] }));
    lenses.push(new vscode.CodeLens(range, { title: 'Sort A→Z', command: 'flutterPubToolkit.sortDependencies' }));
    return lenses;
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

async function generateAssets(uri?: vscode.Uri, silent = false): Promise<void> {
  const dir = await projectDir(uri);
  if (!dir) { return; }
  const output = config().get<string>('assetsOutput') || 'lib/gen/assets.dart';
  const className = config().get<string>('assetsClassName') || 'Assets';
  try {
    const { file, count } = await generateAssetsFile(dir, output, className);
    if (silent) { return; }
    const a = await vscode.window.showInformationMessage(`Generated ${className} with ${count} assets → ${output}`, 'Open');
    if (a) { await vscode.window.showTextDocument(vscode.Uri.file(file)); }
  } catch (e) {
    vscode.window.showErrorMessage(`Could not generate assets: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  diagnostics = vscode.languages.createDiagnosticCollection(DIAG_SOURCE);
  latestDecoration = vscode.window.createTextEditorDecorationType({ after: { color: new vscode.ThemeColor('editorCodeLens.foreground') } });
  outdatedDecoration = vscode.window.createTextEditorDecorationType({ after: { color: new vscode.ThemeColor('editorWarning.foreground') } });
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'flutterPubToolkit.checkUpdates';

  const selector: vscode.DocumentSelector = [
    { language: 'yaml', pattern: '**/pubspec.yaml' },
    { scheme: 'file', pattern: '**/pubspec.yaml' },
  ];

  const pubspecFromArg = (uri?: vscode.Uri) => {
    const doc = uri ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) : vscode.window.activeTextEditor?.document;
    return doc && isPubspec(doc) ? Promise.resolve(doc) : projectDir(uri).then((dir) => dir ? vscode.workspace.openTextDocument(path.join(dir, 'pubspec.yaml')) : undefined);
  };

  // Re-scan imports when Dart files change, then refresh open pubspecs (for "unused" hints).
  const dartWatcher = vscode.workspace.createFileSystemWatcher('**/*.dart');
  let importTimer: NodeJS.Timeout | undefined;
  const onDartChanged = () => {
    invalidateImports();
    clearTimeout(importTimer);
    importTimer = setTimeout(() => vscode.workspace.textDocuments.forEach((d) => scheduleCheck(d, 0)), 1500);
  };

  context.subscriptions.push(
    diagnostics,
    latestDecoration,
    outdatedDecoration,
    statusItem,
    codeLensChanged,
    dartWatcher,
    dartWatcher.onDidCreate(onDartChanged),
    dartWatcher.onDidDelete(onDartChanged),
    dartWatcher.onDidChange(onDartChanged),
    vscode.languages.registerCodeActionsProvider(selector, new PubspecCodeActions(), { providedCodeActionKinds: PubspecCodeActions.kinds }),
    vscode.languages.registerCodeLensProvider(selector, new PubspecCodeLens()),
    vscode.languages.registerHoverProvider(selector, new PackageHover()),
    vscode.languages.registerCompletionItemProvider(selector, new PackageCompletion(), ':', ' ', '^'),

    vscode.workspace.onDidOpenTextDocument((d) => scheduleCheck(d, 0)),
    vscode.workspace.onDidSaveTextDocument((d) => {
      scheduleCheck(d, 0);
      if (isPubspec(d) && config().get<boolean>('assetsAutoGenerate')) {
        void generateAssets(d.uri, true);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isPubspec(e.document) && e.contentChanges.length) {
        results.delete(e.document.uri.toString());
        refreshDecorations();
        scheduleCheck(e.document);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((d) => { diagnostics.delete(d.uri); results.delete(d.uri.toString()); }),
    vscode.window.onDidChangeVisibleTextEditors(refreshDecorations),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('flutterPubToolkit')) {
        vscode.workspace.textDocuments.forEach((d) => scheduleCheck(d, 0));
      }
    }),

    vscode.commands.registerCommand('flutterPubToolkit.checkUpdates', async (uri?: vscode.Uri) => {
      clearCache();
      invalidateImports();
      const doc = await pubspecFromArg(uri);
      if (doc) {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Checking pub.dev…' }, () => checkDocument(doc, true));
      }
    }),
    vscode.commands.registerCommand('flutterPubToolkit.updateAll', async (uri?: vscode.Uri) => {
      const doc = await pubspecFromArg(uri);
      if (doc) { await updateAll(doc); }
    }),
    vscode.commands.registerCommand('flutterPubToolkit.updateAllSafe', async (uri?: vscode.Uri) => {
      const doc = await pubspecFromArg(uri);
      if (doc) { await updateAll(doc, true); }
    }),
    vscode.commands.registerCommand('flutterPubToolkit.sortDependencies', async (uri?: vscode.Uri) => {
      const doc = await pubspecFromArg(uri);
      if (doc) { await sortDocument(doc); }
    }),
    vscode.commands.registerCommand('flutterPubToolkit.ignorePackage', async (name: string) => {
      const list = config().get<string[]>('ignoredPackages') ?? [];
      if (!list.includes(name)) {
        await config().update('ignoredPackages', [...list, name], vscode.ConfigurationTarget.Workspace);
      }
    }),
    vscode.commands.registerCommand('flutterPubToolkit.generateAssets', (uri?: vscode.Uri) => generateAssets(uri)),
    vscode.commands.registerCommand('flutterPubToolkit.pubGet', (uri?: vscode.Uri) => runInTerminal(uri, 'pub get')),
    vscode.commands.registerCommand('flutterPubToolkit.pubUpgrade', (uri?: vscode.Uri) => runInTerminal(uri, 'pub upgrade')),
    vscode.commands.registerCommand('flutterPubToolkit.pubOutdated', (uri?: vscode.Uri) => runInTerminal(uri, 'pub outdated')),
    vscode.commands.registerCommand('flutterPubToolkit.buildRunnerBuild', (uri?: vscode.Uri) => runInTerminal(uri, 'dart run build_runner build --delete-conflicting-outputs')),
    vscode.commands.registerCommand('flutterPubToolkit.buildRunnerWatch', (uri?: vscode.Uri) => runInTerminal(uri, 'dart run build_runner watch --delete-conflicting-outputs', 'build_runner watch')),
    vscode.commands.registerCommand('flutterPubToolkit.buildRunnerClean', (uri?: vscode.Uri) => runInTerminal(uri, 'dart run build_runner clean')),
    vscode.commands.registerCommand('flutterPubToolkit.flutterClean', (uri?: vscode.Uri) => runInTerminal(uri, 'clean && pub get')),
  );

  vscode.workspace.textDocuments.forEach((d) => scheduleCheck(d, 0));
  updateStatus();
}

export function deactivate(): void {
  timers.forEach((t) => clearTimeout(t));
}
