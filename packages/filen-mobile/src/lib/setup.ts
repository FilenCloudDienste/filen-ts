import secureStore from "@/lib/secureStore"
import auth from "@/lib/auth"
import cache from "@/lib/cache"
import { run, Semaphore } from "@filen/utils"
import { restoreQueries } from "@/queries/client"
import sqlite from "@/lib/sqlite"
import foregroundService from "@/features/transfers/foregroundService"
import driveSearch from "@/features/drive/driveSearch"
import { startReconnectListener } from "@/lib/reconnect"
import { initI18n } from "@/lib/i18n"
import { initTheme } from "@/lib/theme"
import { Image } from "expo-image"
import { Platform } from "react-native"
import { CACHE_MAX_SIZE_BYTES } from "@/lib/cacheEviction"
import logger from "@/lib/logger"

// Serializes setup() so a concurrent invocation (e.g. background task overlapping the
// foreground launch) can't run the init flow twice. No other instance state -> plain object.
//
// Idempotency contract (audit B2b, 2026-06-11): setup() itself holds NO once-flag — every
// step is idempotent where its state lives, so repeat calls (iOS cold background launch runs
// the task body's setup AND RootLayout's; a warm Android process re-runs setup per WorkManager
// fire) are cheap and never destructive: auth.setSdkClients same-input fast path (no destroy
// of live handles), sqlite.init/secureStore.init initDone guards, cache.restore once-per-
// session, QueryPersisterKv.restore once-per-instance, startReconnectListener started guard,
// initI18n/initTheme re-init no-ops. auth.isAuthed() is re-evaluated EVERY call by design —
// the result must track login/logout transitions within a process.
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

			// Bound expo-image's iOS disk cache (SDWebImage) to match Android's Glide default
			// (~250MB). Without it iOS is size-unbounded — only a 1-week age cap — which is the
			// main driver of the "temporary cache" (sandbox) growth. iOS only: there is no
			// Android configureCache, and the JS call would throw on the missing native function.
			// Idempotent and pure native config, so it's safe to re-run on every setup().
			if (Platform.OS === "ios") {
				try {
					Image.configureCache({
						maxDiskSize: CACHE_MAX_SIZE_BYTES
					})
				} catch (e) {
					logger.error("setup", "Image.configureCache failed", { error: String(e) })
				}
			}

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
				foregroundService.init().catch(e => { logger.error("setup", "foregroundService.init failed", { error: String(e) }) })

				// configureCache is pure storage (opens no DB until the first search), so this is
				// fire-and-forget and cheap. Gated like foregroundService: never in a headless
				// background run (no search worker there), and only when authed.
				driveSearch.init().catch(e => { logger.error("setup", "driveSearch.init failed", { error: String(e) }) })
			}

			const duration = performance.now() - now

			console.log(`[Setup] Completed in ${duration.toFixed(2)}ms`)

			return {
				isAuthed: isAuthed.isAuthed
			}
		})

		if (!result.success) {
			logger.error("setup", "setup pipeline failed", { error: String(result.error) })

			throw result.error
		}

		return {
			isAuthed: result.data.isAuthed
		}
	}
}

export default setup
