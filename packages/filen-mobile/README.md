# @filen/mobile

Filen mobile app for iOS and Android. Lives inside the `filen-ts` monorepo at `packages/filen-mobile/`.

Built on Expo 55 / React Native 0.83 / React 19 / Hermes. All server communication, encryption and auth go through `@filen/sdk-rs` (Rust SDK consumed as a React Native turbo module).

The iOS File Provider Extension and the Android Documents Provider are wired in via three vendored git submodules under this package (`filen-rs/`, `filen-ios-file-provider/`, `filen-android-documents-provider/`) and three custom Expo config plugins (`plugins/withFileProvider.ts`, `plugins/withAndroidRustBuild.ts`, `plugins/withAndroidArchitectures.ts`). Those plugins compile a separate Rust crate (`filen-mobile-native-cache`) and inject it into the iOS extension target and the Android `jniLibs/`.

---

## Prerequisites

### Toolchain

- **Node.js 24+** (older versions may work, but the old app required 24+; not relaxed in the rewrite).
- **Rust** — install via [rustup](https://www.rust-lang.org/tools/install).
- **cargo-ndk** for Android Rust cross-compilation:
  ```bash
  cargo install cargo-ndk
  ```
- **Rust targets** for the file/documents provider native build:
  ```bash
  rustup target add aarch64-apple-ios
  rustup target add aarch64-apple-ios-sim
  rustup target add aarch64-linux-android
  rustup target add x86_64-linux-android
  ```

### iOS

- **Xcode 16+** (iOS deployment target is 26.0 for the parent app).
- The Apple-Silicon developer setup expected by Expo — see [Expo iOS setup](https://docs.expo.dev/get-started/set-up-your-environment/?platform=ios&device=simulated&mode=development-build&buildEnv=local).
- For real-device builds: an Apple Developer account on team `7YTW5D2K7P` (or whichever team owns `io.filen.app` if you're forking). The file provider extension requires the same team and the `group.io.filen.app` app group.

### Android

- **OpenJDK 17** (newer is fine, older is not). On macOS via Homebrew:
  ```bash
  brew install openjdk@17
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  java -version && javac -version && echo "$JAVA_HOME"
  ```
- The rest of the standard Android SDK + emulator setup — see [Expo Android setup](https://docs.expo.dev/get-started/set-up-your-environment/?platform=android&device=simulated&mode=development-build&buildEnv=local).
- Min SDK 33, target SDK 36.

---

## Clone

Submodules **must** be initialized recursively, or the file/documents-provider prebuild will fail with confusing errors:

```bash
git clone --recursive https://github.com/FilenCloudDienste/filen-ts
```

Already cloned without `--recursive`? Fix it from the repo root:

```bash
git submodule update --init --recursive
```

The three submodules under `packages/filen-mobile/` are:

| Submodule | Purpose |
|---|---|
| `filen-rs/` | Rust monorepo. Hosts the `filen-mobile-native-cache` crate that the file/documents provider extensions build against. |
| `filen-ios-file-provider/` | Swift source for the iOS File Provider Extension. Copied into the Xcode project at prebuild time. |
| `filen-android-documents-provider/` | Kotlin source for the Android Documents Provider. Copied into the app's java tree at prebuild time. |

---

## Install dependencies

From the repo root:

```bash
npm install
```

(Workspace-aware — installs deps for every package in `packages/*` including `filen-mobile`.)

---

## Prebuild

Generates the native `ios/` and `android/` projects from `app.config.ts`. The custom plugins compile the file/documents provider native code as part of this step:

```bash
cd packages/filen-mobile
npm run prebuild:clean
```

What `prebuild:clean` does end to end:

1. Runs `clean.ts` — removes stale `ios/`, `android/`, and `.expo/` outputs.
2. Runs `expo prebuild --clean` — applies every plugin in `app.config.ts` in order.
3. For iOS: `plugins/withFileProvider.ts` runs cargo + `uniffi-bindgen-swift` to produce `filen-rs/target/ios/libfilen_mobile_native_cache.xcframework`, then adds the `FilenFileProvider` extension target to the Xcode project with the right entitlements, Info.plist (NSExtension config), and `PrivacyInfo.xcprivacy`.
4. For Android: `plugins/withAndroidRustBuild.ts` runs `cargo ndk` to produce `lib*.so` files for each target ABI, generates the Kotlin uniffi bindings, copies `FilenDocumentsProvider.kt` into the app's java package, and injects the `<provider>` element into `AndroidManifest.xml`.

---

## Run

| Goal | Command |
|---|---|
| Start Metro (clears cache) | `npm run start` |
| Run iOS sim (debug) | `npm run ios` |
| Run iOS physical device (debug) | `npm run ios:device` |
| Run iOS sim (Release config) | `npm run ios:release` |
| Run iOS physical device (Release) | `npm run ios:device:release` |
| Run Android emulator | `npm run android` |
| Run Android physical device | `npm run android:device` |
| Run Android emulator (release variant) | `npm run android:release` |
| Run Android physical device (release variant) | `npm run android:device:release` |
| EAS dev build (iOS) | `npm run ios:eas:dev` |
| EAS dev build (Android) | `npm run android:eas:dev` |
| EAS production build (iOS) | `npm run ios:eas:release` |
| EAS production build (Android) | `npm run android:eas:release` |

All `expo run:*` commands assume a prior `npm run prebuild:clean` (or a clean `ios/`/`android/` tree already present).

---

## Quality checks

```bash
npm run verify   # lint + typecheck + tests, in that order
npm run lint     # eslint, max-warnings 0
npm run typecheck  # tsc --noEmit (driven by typecheck.mjs)
npm run test     # vitest run
```

Tests live in `src/tests/*.test.ts` and run under Node with mocks for React Native / expo-file-system / expo-media-library / `@filen/sdk-rs`. The three vendored submodules are excluded from lint, typecheck and tests.

---

## Cleaning

| Goal | Command |
|---|---|
| Drop `.expo/` build artifacts | `npm run clean` |
| Drop everything (`.expo/`, DerivedData, `.gradle`, Rust target dirs) | `npm run superclean` |
| Clean prebuild for a specific platform on CI | `npm run prebuild:ci:ios` / `npm run prebuild:ci:android` |

---

## File / Documents Provider notes

The TS bridge that writes `auth.json` (consumed by both native extensions) lives at `src/lib/fileProvider.ts`. It writes into:

- iOS: the shared app-group container (`group.io.filen.app`), accessible to the extension process.
- Android: the app's `filesDir`, accessible to the documents provider in-process.

The schema is the legacy 8-field TS SDK shape. Two fields (`masterKeys`, `publicKey`) are currently stubbed empty — the new Rust SDK (`@filen/sdk-rs`) does not yet expose them via `StringifiedClient`. Reconciling that is a future change: either extending the Rust SDK to surface them, or updating `filen-mobile-native-cache` to consume the new SDK shape directly. Until then the extensions install and load, but auth-dependent operations from inside the extensions will not succeed end-to-end.

---

## License

AGPL-3.0. See the repository's `LICENSE` file.
