# Flutter Pub Toolkit

Productivity tools for **Flutter & Dart** developers in VS Code.

## Features

### Outdated dependency detection in `pubspec.yaml`
Every hosted dependency is checked against **pub.dev** when you open or save `pubspec.yaml`.
Outdated packages are underlined and show the latest version inline (`→ 3.1.0`); up-to-date ones get a `✓`.
Discontinued packages are flagged too.

### One-click updates
- **Quick fix** (`Cmd+.` / `Ctrl+.`) on an outdated version: *Update to ^x.y.z* (keeps your caret / exact / quoted style).
- **Update all outdated dependencies** from the quick-fix menu or the command palette.

### pub.dev autocomplete
Start typing a package name under `dependencies:` / `dev_dependencies:` and get suggestions from pub.dev,
inserted with their latest version. After `package_name: ` you get the latest version suggested.

### Package info on hover
Hover a dependency to see its description, latest stable/prerelease versions and links to the changelog, versions and repository.

### Commands
Command Palette → **Flutter Pub Toolkit**:
- Check for Package Updates
- Update All Dependencies to Latest
- Pub Get / Pub Upgrade
- build_runner: Build / Watch / Clean (with `--delete-conflicting-outputs`)
- Flutter Clean + Pub Get

Automatically uses `flutter` or `dart` depending on the project, and supports FVM.

### Dart snippets
| Prefix  | Inserts |
|---------|---------|
| `frz`   | Freezed data class with `fromJson` |
| `frzu`  | Freezed sealed union state |
| `jsonc` | `@JsonSerializable` class |
| `partg` / `partf` | `part 'file.g.dart';` / `part 'file.freezed.dart';` |
| `cubit` | flutter_bloc Cubit |
| `stlk`  | StatelessWidget with `super.key` |
| `stfl`  | StatefulWidget with `initState` / `dispose` |

## Settings
| Setting | Default | Description |
|---------|---------|-------------|
| `flutterPubToolkit.checkOnOpen` | `true` | Check pub.dev when a pubspec is opened/saved |
| `flutterPubToolkit.includePrerelease` | `false` | Suggest prerelease versions |
| `flutterPubToolkit.severity` | `warning` | Severity for outdated packages |
| `flutterPubToolkit.ignoredPackages` | `[]` | Packages never flagged |
| `flutterPubToolkit.useFvm` | `false` | Prefix commands with `fvm` |

## License
MIT
