import { requireOptionalNativeModule } from "expo-modules-core"

// iOS-only bridge to NSFileProviderManager. A replicated NSFileProviderExtension (what
// filen-ios-file-provider ships) has NO implicit default domain: unless the containing app registers
// one, the system never instantiates the extension and nothing appears in Files.app.
// @/features/settings/fileProvider.ts owns the calls. See ./README.md.

type FileProviderDomainNativeModule = {
	registerDomain: (identifier: string, displayName: string) => Promise<void>
	unregisterDomain: (identifier: string) => Promise<void>
	isDomainRegistered: (identifier: string) => Promise<boolean>
}

// requireOPTIONALNativeModule (not requireNativeModule): the module is absent on Android and on any
// JS bundle running against a binary that wasn't prebuilt with it (stale dev client / CI). Returning
// null instead of throwing at import time keeps that from crashing app startup through the import
// chain — the stubs below then degrade to "no domain registered".
const native = requireOptionalNativeModule<FileProviderDomainNativeModule>("FileProviderDomain")

/**
 * Registers the Filen NSFileProviderDomain so the system instantiates the extension. Idempotent —
 * adding an already-registered domain is a no-op, so repeated enable() calls are safe. Rejects when
 * the system refuses the registration; no-op when the native module is unavailable.
 */
export async function registerDomain(identifier: string, displayName: string): Promise<void> {
	if (!native) {
		return
	}

	return native.registerDomain(identifier, displayName)
}

/** Removes the domain. No-op when it isn't registered, or off iOS. */
export async function unregisterDomain(identifier: string): Promise<void> {
	if (!native) {
		return
	}

	return native.unregisterDomain(identifier)
}

/** Whether the system currently has the domain. `false` when the native module is unavailable. */
export async function isDomainRegistered(identifier: string): Promise<boolean> {
	if (!native) {
		return false
	}

	return native.isDomainRegistered(identifier)
}
