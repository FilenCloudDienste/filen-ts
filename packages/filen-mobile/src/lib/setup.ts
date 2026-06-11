import secureStore from "@/lib/secureStore"
import auth from "@/lib/auth"
import cache from "@/lib/cache"
import { run, Semaphore } from "@filen/utils"
import { restoreQueries } from "@/queries/client"
import sqlite from "@/lib/sqlite"
import foregroundService from "@/features/transfers/foregroundService"
import { startReconnectListener } from "@/lib/reconnect"
import { initI18n } from "@/lib/i18n"
import { initTheme } from "@/lib/theme"

// Serializes setup() so a concurrent invocation (e.g. background task overlapping the
// foreground launch) can't run the init flow twice. No other instance state -> plain object.
const setupMutex = new Semaphore(1)

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
	const start = performance.now()
	const result = await fn()

	console.log(`[Setup] ${label} in ${(performance.now() - start).toFixed(2)}ms`)

	return result
}

const setup = {
	async setup(options?: { background?: boolean }): Promise<{
		isAuthed: boolean
	}> {
		const result = await run(async defer => {
			await setupMutex.acquire()

			defer(() => {
				setupMutex.release()
			})

			const now = performance.now()

			// Crash-orphan sweeps (filen-tmp/ staging + stray .filendl partials) are NOT run
			// at boot — the stray-file walk scales with the offline store (measured 1.9s with
			// a heavily offline-marked drive). They live in Settings → Advanced ("Clean up
			// temporary files"), gated on the transfers/sync stores so they can't race
			// in-flight downloads.

			const isAuthed = await timed("auth.isAuthed", () => auth.isAuthed())
			const stringifiedClient = isAuthed.isAuthed && isAuthed.stringifiedClient ? isAuthed.stringifiedClient : null

			if (stringifiedClient) {
				cache.rootUuid = stringifiedClient.rootUuid
			}

			// initI18n / initTheme only read the persisted language / theme from secureStore, which
			// auth.isAuthed() above already initialized — so they run inside this Promise.all to overlap
			// with the SQLite/cache restore instead of serializing after it. They stay awaited: RootLayout
			// renders null until setup resolves, so i18n and the theme override are applied before first
			// paint (no flash of raw keys or the wrong theme). initTheme is a no-op when following the
			// system (uniwind already defaults to it on import).
			//
			// auth.setSdkClients only needs the auth result — nothing else in this block touches the SDK
			// client (the restores only deserialize, and the reconnect listener attaches after the block),
			// so the Rust client construction overlaps the restores instead of serializing before them.
			//
			// cache.restore() is gated on auth: the persistent caches hold decrypted-at-rest metadata, so
			// hydrating them while logged out would re-surface a prior account's data (the logout wipe
			// clears them; restoring unconditionally would defeat it). When unauthed the maps stay
			// un-ready, which is correct — nothing writes the persistent caches before login.
			await Promise.all([
				stringifiedClient
					? timed("auth.setSdkClients", async () => {
							await auth.setSdkClients(stringifiedClient)
						})
					: Promise.resolve(),
				secureStore.init(),
				timed("sqlite.init", () => sqlite.init()),
				isAuthed.isAuthed ? cache.restore() : Promise.resolve(),
				restoreQueries(),
				timed("initI18n", () => initI18n()),
				initTheme()
			])

			// Wire the reconnect-replay listener after the query cache is hydrated.
			// Idempotent — only attaches the onlineManager subscription on first call.
			startReconnectListener()

			// fileCache/audioCache gc no longer runs at boot — both caches schedule a
			// debounced gc after writes and gc on app-background, so reclamation happens
			// where growth happens instead of competing with startup.
			if (isAuthed.isAuthed && !options?.background) {
				foregroundService.init().catch(console.error)
			}

			const duration = performance.now() - now

			console.log(`[Setup] Completed in ${duration.toFixed(2)}ms`)

			return {
				isAuthed: isAuthed.isAuthed
			}
		})

		if (!result.success) {
			throw result.error
		}

		return {
			isAuthed: result.data.isAuthed
		}
	}
}

export default setup
