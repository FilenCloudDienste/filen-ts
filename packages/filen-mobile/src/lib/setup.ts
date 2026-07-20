import secureStore from "@/lib/secureStore"
import auth from "@/lib/auth"
import cache from "@/lib/cache"
import thumbnails from "@/lib/thumbnails"
import { run, Semaphore } from "@filen/utils"
import { restoreQueries } from "@/queries/client"
import sqlite from "@/lib/sqlite"
import foregroundService from "@/features/transfers/foregroundService"
import driveSearch from "@/features/drive/driveSearch"
import { warmSeedDriveCaches } from "@/features/drive/driveWarmSeed"
import fileProvider from "@/features/settings/fileProvider"
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
// of live handles), sqlite.init/secureStore.init initDone guards, QueryPersisterKv.restore
// once-per-instance, startReconnectListener started guard, initI18n/initTheme re-init no-ops.
// auth.isAuthed() is re-evaluated EVERY call by design —
// the result must track login/logout transitions within a process.
const setupMutex = new Semaphore(1)

// Storage-driven OOM triage: a giant persisted row (e.g. a whale account's photos listing)
// is invisible in a native crash trace, and the abort itself never reaches JS — so boot
// profiles the kv store after the restores land. Debug breadcrumb normally; past the
// watermarks it escalates to a PERSISTED warn, leaving durable evidence in a log export
// even from an install that OOM-loops at startup.
const KV_STATS_WARN_TOTAL_BYTES = 32 * 1024 * 1024
const KV_STATS_WARN_ROW_BYTES = 4 * 1024 * 1024

function logKvStats(): void {
	// Diagnostics must never take setup down — same invariant as the logger itself.
	try {
		sqlite
			.kvStats()
			.then(stats => {
				const payload = {
					rows: stats.rows,
					totalMb: (stats.totalBytes / 1048576).toFixed(2),
					largest: stats.largest.map(row => ({ key: row.key.slice(0, 120), kb: Math.round(row.bytes / 1024) }))
				}

				if (stats.totalBytes > KV_STATS_WARN_TOTAL_BYTES || (stats.largest[0]?.bytes ?? 0) > KV_STATS_WARN_ROW_BYTES) {
					logger.warn("setup", "kv store unusually large", payload)
				} else {
					logger.debug("setup", "kv store size", payload)
				}
			})
			.catch(e => {
				logger.warn("setup", "kvStats failed", { error: e })
			})
	} catch (e) {
		logger.warn("setup", "kvStats failed", { error: e })
	}
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
	const start = performance.now()
	const result = await fn()

	logger.debug("setup", `${label} completed`, { durationMs: (performance.now() - start).toFixed(2) })

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
					logger.error("setup", "Image.configureCache failed", { error: e })
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

			// Refresh the SDK transfer config (concurrency/memory/bandwidth) from persisted prefs
			// BEFORE the client is built in the Promise.all below. Sequenced here (not inside the
			// Promise.all) so the secureStore reads can't race secureStore.init(); auth.isAuthed()
			// above already proved a pre-init secureStore read is safe.
			await auth.loadTransferConfig()

			// Rebuild the disk-derived thumbnail availability Set (sync, once-per-process). Unconditional:
			// not auth-gated (filenames are uuids, no decrypted data) and safe in headless background
			// setups — the once-flag makes the foreground re-run free, and generate paths keep it coherent.
			thumbnails.restore()

			// initI18n / initTheme only read the persisted language / theme from secureStore, which
			// auth.isAuthed() above already initialized — so they run inside this Promise.all to overlap
			// with the SQLite restore instead of serializing after it. They stay awaited: RootLayout
			// renders null until setup resolves, so i18n and the theme override are applied before first
			// paint (no flash of raw keys or the wrong theme). initTheme is a no-op when following the
			// system (uniwind already defaults to it on import).
			//
			// auth.setSdkClients only needs the auth result — nothing else in this block touches the SDK
			// client (the restore only deserializes, and the reconnect listener attaches after the block),
			// so the Rust client construction overlaps the restore instead of serializing before it. The
			// session-scoped metadata maps need no restore; the warm-seed below rebuilds them from the
			// restored listing queries.
			await Promise.all([
				stringifiedClient
					? timed("auth.setSdkClients", async () => {
							await auth.setSdkClients(stringifiedClient)
						})
					: Promise.resolve(),
				secureStore.init(),
				timed("sqlite.init", () => sqlite.init()),
				restoreQueries(),
				timed("initI18n", () => initI18n()),
				initTheme()
			])

			// One-time sweep of the dead cache:v1:* rows left by the removed persistent-map layer —
			// decrypted names must not linger on disk for a user who never logs out; a no-op range seek
			// once clean. Unconditional (the rows are dead regardless of auth); fire-and-forget.
			sqlite.kvAsync.removeByPrefixRange("cache:v1:").catch(e => {
				logger.warn("setup", "legacy cache row sweep failed", { error: e })
			})

			// Rebuilds the session-scoped uuid indexes from the restored listing queries so socket patches,
			// breadcrumbs, and shared-context resolution keep their pre-fetch coverage; foreground-only — a
			// headless run needs none of it.
			if (isAuthed.isAuthed && !options?.background) {
				await timed("warmSeedDriveCaches", () => warmSeedDriveCaches())
			}

			// Wire the reconnect-replay listener after the query cache is hydrated.
			// Idempotent — only attaches the onlineManager subscription on first call.
			startReconnectListener()

			// fileCache/audioCache gc no longer runs at boot — both caches schedule a
			// debounced gc after writes and gc on app-background, so reclamation happens
			// where growth happens instead of competing with startup.
			if (isAuthed.isAuthed && !options?.background) {
				foregroundService.init().catch(e => { logger.error("setup", "foregroundService.init failed", { error: e }) })

				// configureCache is pure storage (opens no DB until the first search), so this is
				// fire-and-forget and cheap. Gated like foregroundService: never in a headless
				// background run (no search worker there), and only when authed.
				driveSearch.init().catch(e => { logger.error("setup", "driveSearch.init failed", { error: e }) })

				// One-time (per launch) beta migration: re-encrypt a legacy plaintext auth.json if the
				// provider is enabled. No-op once auth.json is already encrypted or the provider is off.
				fileProvider.ensureEncrypted().catch(e => { logger.error("setup", "fileProvider.ensureEncrypted failed", { error: e }) })

				// Fire-and-forget: reads run against a page cache the restores just warmed.
				logKvStats()
			}

			const duration = performance.now() - now

			logger.info("setup", "Setup completed", { durationMs: duration.toFixed(2) })

			return {
				isAuthed: isAuthed.isAuthed
			}
		})

		if (!result.success) {
			logger.error("setup", "setup pipeline failed", { error: result.error })

			throw result.error
		}

		return {
			isAuthed: result.data.isAuthed
		}
	}
}

export default setup
