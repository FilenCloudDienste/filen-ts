import secureStore from "@/lib/secureStore"
import auth from "@/lib/auth"
import cache from "@/lib/cache"
import { run, Semaphore } from "@filen/utils"
import { restoreQueries } from "@/queries/client"
import sqlite from "@/lib/sqlite"
import offline from "@/lib/offline"
import alerts from "@/lib/alerts"
import foregroundService from "@/lib/foregroundService"
import { sweepTmpDir } from "@/lib/tmp"
import { sweepStrayDownloadFiles } from "@/lib/fsUtils"
import { startReconnectListener } from "@/lib/reconnect"

class Setup {
	private readonly mutex: Semaphore = new Semaphore(1)

	public async setup(options?: { background?: boolean }): Promise<{
		isAuthed: boolean
	}> {
		const result = await run(async defer => {
			await this.mutex.acquire()

			defer(() => {
				this.mutex.release()
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

const setup = new Setup()

export default setup
