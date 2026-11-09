# Flutter Pub Toolkit

Productivity tools for **Flutter & Dart** developers in VS Code.

## Features

### Outdated dependency detection in `pubspec.yaml`
Every hosted dependency is checked against **pub.dev** when you open or save `pubspec.yaml`.
Outdated packages are underlined and show the latest version inline (`→ 3.1.0`); up-to-date ones get a `✓`.
Discontinued packages are flagged too.

### Safe vs. breaking updates
Major updates are labelled `(major)`. The quick fix (`Cmd+.` / `Ctrl+.`) offers both:
- **Update to ^12.0.3 (safe)**: newest version without breaking changes
- **Update to ^13.0.2 (major, breaking)**
- **Open changelog** on pub.dev

Keeps your caret / exact / quoted style. *Update all* and *Update all (safe only)* are available from the quick-fix menu,
the CodeLens above `dependencies:` and the command palette.

### Unused dependency detection
Packages under `dependencies:` that are never imported in `lib/`, `bin/` or `test/` are faded out, with quick fixes
to **remove** or **ignore** them. Tool packages such as `cupertino_icons`, `flutter_native_splash` and `flutter_launcher_icons` are skipped.

### CodeLens & status bar
Above `dependencies:`: **Update all (N) · Update safe only · Pub get · Sort A→Z**.
The status bar shows how many packages are outdated; click it to re-check.

### Sort dependencies
**Sort Dependencies Alphabetically** sorts every dependency section, keeps `sdk:` entries on top and keeps comments attached to the package below them.

### Assets class generator
**Generate Assets Class** reads `flutter: assets:` from your pubspec and writes `lib/gen/assets.dart`:
```dart
class Assets {
  static const String imagesLogo = 'assets/images/logo.png';
  static const String svgsHomeSearch = 'assets/svgs/home/search.svg';
  static const List<String> values = [...];
}
```
Enable `flutterPubToolkit.assetsAutoGenerate` to regenerate it on every pubspec save.

### pub.dev autocomplete
Start typing a package name under `dependencies:` / `dev_dependencies:` and get suggestions from pub.dev,
inserted with their latest version. After `package_name: ` you get the latest version suggested.

### Package info on hover
Hover a dependency to see its description, latest stable/prerelease versions and links to the changelog, versions and repository.

### Commands
Command Palette → **Flutter Pub Toolkit**:
- Check for Package Updates
- Update All Dependencies to Latest
- Update All Dependencies (Safe, Non-Breaking Only)
- Sort Dependencies Alphabetically
- Generate Assets Class
- Pub Get / Pub Upgrade / Pub Outdated
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
| `flutterPubToolkit.ignoredPackages` | `[]` | Packages never flagged (outdated or unused) |
| `flutterPubToolkit.detectUnused` | `true` | Fade out unused dependencies |
| `flutterPubToolkit.runPubGetAfterUpdate` | `false` | Save and run `pub get` after *Update all* |
| `flutterPubToolkit.assetsOutput` | `lib/gen/assets.dart` | Output of the assets generator |
| `flutterPubToolkit.assetsClassName` | `Assets` | Generated class name |
| `flutterPubToolkit.assetsAutoGenerate` | `false` | Regenerate assets class on pubspec save |
| `flutterPubToolkit.useFvm` | `false` | Prefix commands with `fvm` |

## License
MIT
