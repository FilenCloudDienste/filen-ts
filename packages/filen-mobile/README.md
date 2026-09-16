# @filen/mobile

Filen mobile app for iOS and Android. Lives inside the `filen-ts` monorepo at `packages/filen-mobile/`.

Built on Expo 55 / React Native 0.83 / React 19 / Hermes. All server communication, encryption and auth go through `@filen/sdk-rs` (Rust SDK consumed as a React Native turbo module).

The iOS File Provider Extension and the Android Documents Provider are wired in via three vendored git submodules under this package (`filen-rs/`, `filen-ios-file-provider/`, `filen-android-documents-provider/`) and three custom Expo config plugins (`plugins/withFileProvider.ts`, `plugins/withAndroidRustBuild.ts`, `plugins/withAndroidArchitectures.ts`). Those plugins compile a separate Rust crate (`filen-mobile-native-cache`) and inject it into the iOS extension target and the Android `jniLibs/`.

---

## Prerequisites

### Toolchain

- **Node.js 24+** (older versions may work, but the old app required 24+; not relaxed in the rewrite).
- **Rust** — install via [rustup](https://www.rust-lang.org/tools/install).
- **cargo-ndk** for Android Rust cross-compilation — must be **4.x** (the native build reads cargo-ndk 4.x's `ANDROID_ABI` as of filen-rs `d454f4d`; the old 3.5.4 sets `CARGO_NDK_ANDROID_TARGET` and no longer propagates the heif-decoder ABI):
    ```bash
    cargo install --version 4.1.2 cargo-ndk
    ```
- **meson, ninja, nasm** — filen-rs's `heif-decoder` builds its vendored dav1d (AVIF) with meson + ninja on every target, and nasm assembles the x86_64 Android slice's SIMD; prebuild fails inside its `build.rs` without them:
    ```bash
    brew install meson ninja nasm
    ```
- **Rust targets** for the file/documents provider native build:
    ```bash
    rustup target add aarch64-apple-ios
    rustup target add aarch64-apple-ios-sim
    rustup target add aarch64-linux-android
    rustup target add x86_64-linux-android
    ```

### iOS

- **Xcode 26.5+** (iOS deployment target is 26.0 for the parent app).
- The Apple-Silicon developer setup expected by Expo — see [Expo iOS setup](https://docs.expo.dev/get-started/set-up-your-environment/?platform=ios&device=simulated&mode=development-build&buildEnv=local).

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

| Submodule                           | Purpose                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `filen-rs/`                         | Rust monorepo. Hosts the `filen-mobile-native-cache` crate that the file/documents provider extensions build against. |
| `filen-ios-file-provider/`          | Swift source for the iOS File Provider Extension. Copied into the Xcode project at prebuild time.                     |
| `filen-android-documents-provider/` | Kotlin source for the Android Documents Provider. Copied into the app's java tree at prebuild time.                   |

---

## Install dependencies

This is a pnpm workspace. Install once from the repo root — it covers every package:

```bash
pnpm install
```

Native fixes live as pnpm patches under the root `patches/`, registered in `pnpm-workspace.yaml`
and applied automatically by `pnpm install`. Add a new one with `pnpm patch <name>@<version>` +
`pnpm patch-commit`.

---

## Prebuild

Generates the native `ios/` and `android/` projects from `app.config.ts`. The custom plugins compile the file/documents provider native code as part of this step:

```bash
cd packages/filen-mobile
pnpm run prebuild:clean
```

What `prebuild:clean` does end to end:

1. Runs `clean.ts` — removes stale `ios/`, `android/`, and `.expo/` outputs.
2. Runs `expo prebuild --clean` — applies every plugin in `app.config.ts` in order.
3. For iOS: `plugins/withFileProvider.ts` runs cargo + `uniffi-bindgen-swift` to produce `filen-rs/target/ios/libfilen_mobile_native_cache.xcframework`, then adds the `FilenFileProvider` extension target to the Xcode project with the right entitlements, Info.plist (NSExtension config), and `PrivacyInfo.xcprivacy`.
4. For Android: `plugins/withAndroidRustBuild.ts` runs `cargo ndk` to produce `lib*.so` files for each target ABI, generates the Kotlin uniffi bindings, copies `FilenDocumentsProvider.kt` into the app's java package, and injects the `<provider>` element into `AndroidManifest.xml`.

---

## Run

| Goal                                          | Command                           |
| --------------------------------------------- | --------------------------------- |
| Start Metro (clears cache)                    | `pnpm run start`                  |
| Run iOS sim (debug)                           | `pnpm run ios`                    |
| Run iOS physical device (debug)               | `pnpm run ios:device`             |
| Run iOS sim (Release config)                  | `pnpm run ios:release`            |
| Run iOS physical device (Release)             | `pnpm run ios:device:release`     |
| Run Android emulator                          | `pnpm run android`                |
| Run Android physical device                   | `pnpm run android:device`         |
| Run Android emulator (release variant)        | `pnpm run android:release`        |
| Run Android physical device (release variant) | `pnpm run android:device:release` |

---

## Quality checks

```bash
pnpm run verify   # lint + typecheck + tests, in that order
pnpm run lint     # eslint, max-warnings 0
pnpm run typecheck  # tsc --noEmit (driven by typecheck.mjs)
pnpm run test     # vitest run
```

Tests live in `src/tests/*.test.ts` and run under Node with mocks for React Native / expo-file-system / expo-media-library / `@filen/sdk-rs`. The three vendored submodules are excluded from lint, typecheck and tests.

---

## License

AGPL-3.0. See the repository's `LICENSE` file.
