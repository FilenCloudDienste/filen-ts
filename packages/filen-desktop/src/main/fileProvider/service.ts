import path from "node:path"
import type { DesktopFileProviderErrorCode, DesktopFileProviderResult, DesktopFileProviderState } from "@filen/shared/desktop"
import type { SessionRead } from "../../shared/channels.ts"
import { type AtomicFile, codedError, errorCode } from "../atomicFile.ts"
import { serialQueue } from "../../shared/serial.ts"
import { ADDON_ERROR_DOMAIN, type FileProviderAddon, type FileProviderDomain } from "./addon.ts"
import { domainIdentifier, type FileProviderAuth, fileProviderAuth } from "./authFile.ts"
import type { FileProviderStore } from "./store.ts"

export interface FileProviderDeps {
	// macOS 14 or later with the addon present; decided without loading it.
	supported(): boolean
	// Loads the addon on first use; throws when it cannot be loaded.
	addon(): FileProviderAddon | null
	vault: { get(): Promise<SessionRead> }
	store: FileProviderStore
	// Present while the extension may still hold a session it was told to forget but never confirmed.
	clearOwed: AtomicFile
	// A PIN app lock is set (or one is set but unreadable).
	pinSet(): boolean
	// The app runs from a translocated copy or a disk image.
	translocated(): boolean
	// `~/Library/CloudStorage`, where Finder keeps each domain's directory; `list` names its directories ([] when absent).
	cloudStorage: { root: string; list(): Promise<string[]> }
	// "" on success, else the reason (Electron's shell.openPath).
	openPath(target: string): Promise<string>
	openSettings(): Promise<void>
	log: { info(message: string): void; warn(message: string): void }
}

type Result<T> = DesktopFileProviderResult<T>

export interface FileProviderService {
	state(): Promise<DesktopFileProviderState>
	enable(): Promise<Result<DesktopFileProviderState>>
	disable(): Promise<Result<DesktopFileProviderState>>
	reveal(): Promise<Result<null>>
	openSettings(): Promise<void>
	// Once after startup: a user who has it on gets the domain and the session again.
	launch(): Promise<void>
	// The vault holds a new session (a sign-in, a changed password): pushed while switched on.
	sessionChanged(blob: string): Promise<void>
	// A sign-out (asked for, a lock reset, a revoked session); null when the user is not known.
	signedOut(userId: string | null): Promise<void>
	// A PIN was set: the extension goes off.
	pinChanged(): Promise<void>
}

// The addon's NSError domain and code, else the usual code.
function describe(error: unknown): string {
	if (error instanceof Error && "domain" in error && "code" in error) {
		return `${String(error.domain)} ${String(error.code)}`
	}

	return errorCode(error)
}

const FILE_PROVIDER_ERROR_DOMAIN = "NSFileProviderErrorDomain"

function isSystemError(error: unknown): boolean {
	return error instanceof Error && "domain" in error && error.domain === FILE_PROVIDER_ERROR_DOMAIN
}

// NSFileProviderError.h: providerNotFound, providerTranslocated and applicationExtensionNotFound.
const PROVIDER_NOT_FOUND = -2001
const PROVIDER_TRANSLOCATED = -2002
const EXTENSION_NOT_FOUND = -2014
// The addon's XPC call unanswered in time.
const ADDON_TIMEOUT = 4

const REFUSALS: ReadonlyMap<string, DesktopFileProviderErrorCode> = new Map([
	["file provider unsupported", "unsupported"],
	["app lock set", "appLocked"],
	["no session", "noSession"],
	["translocated", "translocated"],
	["not found", "notFound"]
])

// What a failure means to the user: main's own refusals by their code, the system's by its NSError.
export function fileProviderErrorCode(error: unknown): DesktopFileProviderErrorCode {
	if (error instanceof Error && "domain" in error && "code" in error) {
		if (error.domain === FILE_PROVIDER_ERROR_DOMAIN) {
			switch (error.code) {
				case PROVIDER_TRANSLOCATED:
					return "translocated"
				case PROVIDER_NOT_FOUND:
				case EXTENSION_NOT_FOUND:
					return "extensionMissing"
			}
		} else if (error.domain === ADDON_ERROR_DOMAIN && error.code === ADDON_TIMEOUT) {
			return "timeout"
		}

		return "unknown"
	}

	return REFUSALS.get(errorCode(error)) ?? "unknown"
}

// Finder names a domain's directory "<app>-<display name>": the release build's name first, then any Filen build's (a
// development one). Names compare in NFC, as the file system may hand them back decomposed.
export function fileProviderDirectory(entries: readonly string[], displayName: string): string | null {
	const suffix = `-${displayName}`.normalize("NFC")
	const exact = `Filen${suffix}`
	let fallback: string | null = null

	for (const entry of entries) {
		const name = entry.normalize("NFC")

		if (name === exact) {
			return entry
		}

		if (fallback === null && name.startsWith("Filen") && name.endsWith(suffix)) {
			fallback = entry
		}
	}

	return fallback
}

// The app runs from where macOS refuses a File Provider: a translocated copy (a quarantined app opened from Downloads)
// or a mounted disk image. Development runs are never refused.
export function runsTranslocated(options: { packaged: boolean; inApplications: boolean; appPath: string }): boolean {
	return (
		options.packaged &&
		!options.inApplications &&
		(options.appPath.includes("/AppTranslocation/") || options.appPath.startsWith("/Volumes/"))
	)
}

// Every operation runs one at a time. The addon loads only when a user has the extension on, or to switch it off. The
// session goes over XPC only, never into the app group; an unreadable vault is never acted on. Leaving it off fails
// closed: the domain is removed even when the extension did not confirm forgetting the session, and the next
// registration tells it again.
export function createFileProviderService(deps: FileProviderDeps): FileProviderService {
	const serial = serialQueue()
	const { info, warn } = deps.log
	// The user whose domain this run registered.
	let registered: string | null = null
	// macOS refused the domain as translocated; that holds for the rest of the run.
	let translocatedSeen = false

	function addon(): FileProviderAddon {
		const loaded = deps.addon()

		if (loaded === null) {
			throw codedError("file provider unsupported")
		}

		return loaded
	}

	async function presentAuth(): Promise<FileProviderAuth | null> {
		const read = await deps.vault.get()

		return read.status === "present" ? fileProviderAuth(read.blob) : null
	}

	async function register(auth: FileProviderAuth): Promise<void> {
		const fp = addon()
		const identifier = domainIdentifier(auth.userId)

		if (registered !== null && registered !== auth.userId) {
			await teardown(registered)
		}

		await fp.addDomain({ identifier, displayName: auth.displayName })
		registered = auth.userId

		if ((await deps.clearOwed.read()) !== null) {
			try {
				await fp.clearAuth({ identifier })
				await deps.clearOwed.remove()
				info("file provider: owed session clear done")
			} catch (error) {
				warn(`file provider: owed session clear failed: ${describe(error)}`)
			}
		}

		await fp.pushAuth({ identifier, json: auth.json })
		info("file provider: session pushed")
	}

	// The extension forgets the session, then the domain goes with its replicated files.
	async function teardown(userId: string): Promise<void> {
		const fp = addon()
		const identifier = domainIdentifier(userId)

		try {
			await fp.clearAuth({ identifier })
			info("file provider: session cleared")
		} catch (error) {
			warn(`file provider: session clear failed (${describe(error)}); owed to the next registration`)
			await deps.clearOwed.write(Buffer.alloc(0)).catch((markError: unknown) => {
				warn(`file provider: owed clear not recorded: ${errorCode(markError)}`)
			})
		}

		if (registered === userId) {
			registered = null
		}

		await fp.removeDomain({ identifier })
		info("file provider: domain removed")
	}

	// Off for the user whatever the teardown did; its failure is the caller's.
	async function switchOff(userId: string): Promise<void> {
		try {
			await teardown(userId)
		} finally {
			await deps.store.setEnabled(userId, false)
		}
	}

	async function currentState(): Promise<DesktopFileProviderState> {
		const supported = deps.supported()
		const state: DesktopFileProviderState = {
			supported,
			enabled: false,
			lockBlocked: deps.pinSet(),
			userEnabled: null,
			translocated: supported && (translocatedSeen || deps.translocated())
		}

		if (!state.supported) {
			return state
		}

		const auth = await presentAuth()

		if (auth === null || !(await deps.store.enabled(auth.userId))) {
			return state
		}

		const identifier = domainIdentifier(auth.userId)
		let domains: FileProviderDomain[]

		try {
			domains = await addon().listDomains()
		} catch (error) {
			if (!isSystemError(error)) {
				throw error
			}

			// macOS answers for no domain of this app (no extension, a translocated copy): on, but not registered.
			warn(`file provider: domains not listed: ${describe(error)}`)

			if (fileProviderErrorCode(error) === "translocated") {
				translocatedSeen = true
			}

			return { ...state, enabled: true, translocated: state.translocated || translocatedSeen }
		}

		return { ...state, enabled: true, userEnabled: domains.find(entry => entry.identifier === identifier)?.userEnabled ?? null }
	}

	// A page's request: a failure is logged and answered as its code.
	function result<T>(what: string, operation: () => Promise<T>): Promise<Result<T>> {
		return serial(async (): Promise<Result<T>> => {
			try {
				return { ok: true, value: await operation() }
			} catch (error) {
				const code = fileProviderErrorCode(error)

				warn(`file provider: ${what} failed: ${describe(error)}`)

				return { ok: false, error: code === "unknown" ? { code, message: describe(error) } : { code } }
			}
		})
	}

	function background(what: string, operation: () => Promise<void>): Promise<void> {
		return serial(operation).catch((error: unknown) => {
			warn(`file provider: ${what} failed: ${describe(error)}`)
		})
	}

	return {
		state: () => serial(currentState),
		enable: () =>
			result("enable", async () => {
				if (!deps.supported()) {
					throw codedError("file provider unsupported")
				}

				if (deps.pinSet()) {
					throw codedError("app lock set")
				}

				if (translocatedSeen || deps.translocated()) {
					throw codedError("translocated")
				}

				const auth = await presentAuth()

				if (auth === null) {
					throw codedError("no session")
				}

				await deps.store.setEnabled(auth.userId, true)

				try {
					await register(auth)
				} catch (error) {
					// Nothing the next launch could retry: it stays off until the app runs from Applications.
					if (fileProviderErrorCode(error) === "translocated") {
						translocatedSeen = true
						await deps.store.setEnabled(auth.userId, false)
					}

					throw error
				}

				info("file provider: enabled")

				return currentState()
			}),
		disable: () =>
			result("disable", async () => {
				const user = (await presentAuth())?.userId ?? registered

				if (deps.supported() && user !== null) {
					await switchOff(user)
					info("file provider: disabled")
				}

				return currentState()
			}),
		reveal: () =>
			result("reveal", async () => {
				if (!deps.supported()) {
					throw codedError("file provider unsupported")
				}

				const auth = await presentAuth()

				if (auth === null) {
					throw codedError("no session")
				}

				const directory = (await deps.store.enabled(auth.userId))
					? fileProviderDirectory(await deps.cloudStorage.list(), auth.displayName)
					: null

				if (directory === null) {
					throw codedError("not found")
				}

				const failure = await deps.openPath(path.join(deps.cloudStorage.root, directory))

				if (failure !== "") {
					throw codedError("not found")
				}

				return null
			}),
		openSettings: async () => {
			if (deps.supported()) {
				await deps.openSettings()
			}
		},
		launch: () =>
			background("launch", async () => {
				if (!deps.supported()) {
					return
				}

				const auth = await presentAuth()

				if (auth === null || !(await deps.store.enabled(auth.userId))) {
					return
				}

				// A PIN set while it was on (the old client's, imported) keeps it off.
				if (deps.pinSet()) {
					await switchOff(auth.userId)

					return
				}

				await register(auth)
			}),
		sessionChanged: blob =>
			background("session push", async () => {
				const auth = deps.supported() ? fileProviderAuth(blob) : null

				if (auth === null) {
					return
				}

				if (registered !== null && registered !== auth.userId) {
					await switchOff(registered)
				}

				if (!deps.pinSet() && (await deps.store.enabled(auth.userId))) {
					await register(auth)
				}
			}),
		signedOut: userId =>
			background("sign-out", async () => {
				const user = userId ?? registered

				if (!deps.supported() || user === null || (registered !== user && !(await deps.store.enabled(user)))) {
					return
				}

				await switchOff(user)
			}),
		pinChanged: () =>
			background("app lock", async () => {
				if (!deps.supported()) {
					return
				}

				const user = (await presentAuth())?.userId ?? registered

				if (user !== null && (registered === user || (await deps.store.enabled(user)))) {
					await switchOff(user)
					info("file provider: switched off by the app lock")
				}
			})
	}
}
