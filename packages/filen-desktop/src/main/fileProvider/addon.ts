import path from "node:path"
import { nativeFilePath, type AddonPathContext } from "../native/addonPath.ts"

// The File Provider addon (native/fileProvider, built by scripts/buildFpAddon.ts). Every call settles off the JS thread.
export interface FileProviderDomain {
	identifier: string
	displayName: string
	// false while the user has the domain switched off in System Settings.
	userEnabled: boolean
}

export interface FileProviderAddon {
	// Adds the domain, or updates an existing one's display name.
	addDomain(options: { identifier: string; displayName: string }): Promise<void>
	// Removes the domain and every replicated file of it.
	removeDomain(options: { identifier: string }): Promise<void>
	listDomains(): Promise<FileProviderDomain[]>
	signalWorkingSet(options: { identifier: string }): Promise<void>
	// One-shot XPC calls to the extension's auth service.
	pushAuth(options: { identifier: string; json: string }): Promise<void>
	clearAuth(options: { identifier: string }): Promise<void>
}

// What every call rejects with: the NSError's domain and code (NSFileProviderErrorDomain among them), or the addon's own
// ADDON_ERROR_DOMAIN for invalid arguments (1), no manager for the domain (2), no auth service (3), an XPC call
// unanswered within 30 s (4) or an internal failure (5).
export interface FileProviderError extends Error {
	domain: string
	code: number
}

export const ADDON_ERROR_DOMAIN = "FilenFileProvider"

export interface FileProviderAddonContext extends Omit<AddonPathContext, "env"> {
	// os.release(): the Darwin version.
	release: string
	// The running executable, <bundle>.app/Contents/MacOS/<name>.
	execPath: string
	// Throws when the file is not a loadable addon for this process.
	load(file: string): unknown
}

// macOS 14 is Darwin 23; File Provider is not used below it.
const MIN_DARWIN_MAJOR = 23

// The extension in the app bundle's Contents/PlugIns, put there when packaging.
export const APPEX_NAME = "FilenFileProvider.appex"

// The extension inside the running bundle. An unpackaged run (Electron's own bundle) or a build without it has none.
export function bundledAppexPath(execPath: string): string {
	return path.join(path.dirname(path.dirname(execPath)), "PlugIns", APPEX_NAME)
}

// Null unless this Mac runs File Provider, the running bundle carries the extension and the addon is there.
export function fileProviderAddonPath(ctx: FileProviderAddonContext): string | null {
	const darwinMajor = Number.parseInt(ctx.release, 10)

	if (ctx.platform !== "darwin" || !(darwinMajor >= MIN_DARWIN_MAJOR) || !ctx.exists(bundledAppexPath(ctx.execPath))) {
		return null
	}

	return nativeFilePath(ctx, "filen-fp.node")
}

// Loads the addon on first use only; null where File Provider is unsupported or the addon is missing.
export function createFileProviderAddon(ctx: FileProviderAddonContext): () => FileProviderAddon | null {
	let addon: FileProviderAddon | null | undefined

	return () => {
		if (addon === undefined) {
			const file = fileProviderAddonPath(ctx)

			addon = file === null ? null : (ctx.load(file) as FileProviderAddon)
		}

		return addon
	}
}
