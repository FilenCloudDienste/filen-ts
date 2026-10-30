import type { DesktopFileProviderState } from "@filen/shared/desktop"
import type { SessionRead } from "../../shared/channels.ts"
import { type AtomicFile, codedError, errorCode } from "../atomicFile.ts"
import { serialQueue } from "../../shared/serial.ts"
import type { FileProviderAddon } from "./addon.ts"
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
	log: { info(message: string): void; warn(message: string): void }
}

export interface FileProviderService {
	state(): Promise<DesktopFileProviderState>
	enable(): Promise<DesktopFileProviderState>
	disable(): Promise<DesktopFileProviderState>
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

// Every operation runs one at a time. The addon loads only when a user has the extension on, or to switch it off. The
// session goes over XPC only, never into the app group; an unreadable vault is never acted on. Leaving it off fails
// closed: the domain is removed even when the extension did not confirm forgetting the session, and the next
// registration tells it again.
export function createFileProviderService(deps: FileProviderDeps): FileProviderService {
	const serial = serialQueue()
	const { info, warn } = deps.log
	// The user whose domain this run registered.
	let registered: string | null = null

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
		const state: DesktopFileProviderState = {
			supported: deps.supported(),
			enabled: false,
			lockBlocked: deps.pinSet(),
			userEnabled: null
		}

		if (!state.supported) {
			return state
		}

		const auth = await presentAuth()

		if (auth === null || !(await deps.store.enabled(auth.userId))) {
			return state
		}

		const identifier = domainIdentifier(auth.userId)
		const domain = (await addon().listDomains()).find(entry => entry.identifier === identifier)

		return { ...state, enabled: true, userEnabled: domain?.userEnabled ?? null }
	}

	function background(what: string, operation: () => Promise<void>): Promise<void> {
		return serial(operation).catch((error: unknown) => {
			warn(`file provider: ${what} failed: ${describe(error)}`)
		})
	}

	return {
		state: () => serial(currentState),
		enable: () =>
			serial(async () => {
				if (!deps.supported()) {
					throw codedError("file provider unsupported")
				}

				if (deps.pinSet()) {
					throw codedError("app lock set")
				}

				const auth = await presentAuth()

				if (auth === null) {
					throw codedError("no session")
				}

				await deps.store.setEnabled(auth.userId, true)
				await register(auth)
				info("file provider: enabled")

				return currentState()
			}),
		disable: () =>
			serial(async () => {
				const user = (await presentAuth())?.userId ?? registered

				if (deps.supported() && user !== null) {
					await switchOff(user)
					info("file provider: disabled")
				}

				return currentState()
			}),
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
