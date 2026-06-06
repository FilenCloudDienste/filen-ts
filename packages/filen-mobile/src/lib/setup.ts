import secureStore from "@/lib/secureStore"
import auth from "@/lib/auth"
import cache from "@/lib/cache"
import { run, Semaphore } from "@filen/utils"
import { restoreQueries } from "@/queries/client"
import sqlite from "@/lib/sqlite"
import offline from "@/features/offline/offline"
import alerts from "@/lib/alerts"
import foregroundService from "@/features/transfers/foregroundService"
import { sweepTmpDir } from "@/lib/tmp"
import { sweepStrayDownloadFiles } from "@/lib/fsUtils"
import { startReconnectListener } from "@/lib/reconnect"
import fileCache from "@/lib/fileCache"
import audioCache from "@/features/audio/audioCache"
import { initI18n } from "@/lib/i18n"
import { initTheme } from "@/lib/theme"

// Serializes setup() so a concurrent invocation (e.g. background task overlapping the
// foreground launch) can't run the init flow twice. No other instance state -> plain object.
const setupMutex = new Semaphore(1)

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

			// Wipe filen-tmp/ orphans and stray .filendl partial downloads from crashed
			// sessions. Safe only because no transfers can be in flight before setup()
			// completes.
			if (!options?.background) {
				sweepTmpDir()
				sweepStrayDownloadFiles()
			}

			const isAuthed = await auth.isAuthed()

			if (isAuthed.isAuthed && isAuthed.stringifiedClient) {
				await auth.setSdkClients(isAuthed.stringifiedClient)

				cache.rootUuid = isAuthed.stringifiedClient.rootUuid
			}

			await Promise.all([secureStore.init(), sqlite.init(), cache.restore(), restoreQueries()])

			// Initialize i18next after secureStore.init() resolves (needs the persisted-language
			// read) and before setup returns — RootLayout renders null until setup is done, so
			// i18n is ready before first paint (no flash of raw keys). Serial-awaited, not folded
			// into the Promise.all above (would race the secureStore read).
			await initI18n()

			// Apply the persisted theme override (light/dark) before first paint, same reasoning as
			// initI18n — RootLayout renders null until setup is done, so there's no flash of the wrong
			// theme. No-op when the user follows the system (uniwind already defaults to it on import).
			await initTheme()

			// Wire the reconnect-replay listener after the query cache is hydrated
			// but before the fire-and-forget offline.sync below. Idempotent —
			// only attaches the onlineManager subscription on first call.
			startReconnectListener()

			if (isAuthed.isAuthed && !options?.background) {
				foregroundService.init().catch(console.error)

				// TODO: Move to host component like camera upload
				Promise.all([offline.updateIndex(), offline.sync()]).catch(err => {
					console.error(err)
					alerts.error(err)
				})

				// Reclaim disk space from caches that grow unbounded today.
				// Idempotent; running on an empty cache directory is a no-op.
				// Log-only on failure — gc hygiene isn't user-actionable, so we
				// don't fire a toast (would be noise on every cold start).
				fileCache.gc().catch(console.error)
				audioCache.gc().catch(console.error)
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
