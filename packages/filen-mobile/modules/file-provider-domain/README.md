# file-provider-domain

iOS-only local Expo module wrapping `NSFileProviderManager.add` / `.remove` / `.domains`.

A replicated `NSFileProviderExtension` has **no implicit default domain**. Until the containing app
registers one, the system never instantiates the extension and nothing appears in Files.app.
`src/features/settings/fileProvider.ts` calls `registerDomain` at the end of `enable()` and
`unregisterDomain` at the start of `disable()`.

The extension side lives in the `filen-ios-file-provider` submodule
(`packages/filen-mobile/filen-ios-file-provider`) — the domain identifier registered here is what it
is instantiated for.

## The other half of the app-side contract

The extension also reads a **sealed `auth.json`** from the App Group container: the credentials JSON
encrypted with AES-256-GCM under a DEK in the shared Keychain access group, laid out as
`version(0x01) ++ iv(12) ++ ciphertext ++ tag(16)`. That already exists —
`src/features/settings/authFileKey.ts` (`sealAuthFile` / `getOrCreateAuthDek`), decrypted on the Rust
side by `filen-rs/filen-mobile-native-cache/src/auth.rs`. Registration is the only piece this module
adds; nothing here touches credentials.

## First run: "Sync is not enabled" (-2011)

A freshly registered domain lands with `Enabled = false`. Every request then fails with
`NSFileProviderErrorDomain -2011 "Sync is not enabled"` until the user switches the Filen location on
once in Files.app. That is expected, not a bug — the first coordinated read after that also blocks
~15s while the domain comes up.
