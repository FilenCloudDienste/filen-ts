import secureStore from "@/lib/secureStore"
import auth from "@/lib/auth"
import cache from "@/lib/cache"
import { run, Semaphore } from "@filen/utils"
import { restoreQueries } from "@/queries/client"
import sqlite from "@/lib/sqlite"
import offline from "@/lib/offline"
import alerts from "@/lib/alerts"

class Setup {
	private readonly mutex: Semaphore = new Semaphore(1)

	public async setup(): Promise<{
		isAuthed: boolean
	}> {
		const result = await run(async defer => {
			await this.mutex.acquire()

			defer(() => {
				this.mutex.release()
			})

			const isAuthed = await auth.isAuthed()

			if (isAuthed.isAuthed && isAuthed.stringifiedClient) {
				await auth.setSdkClients(isAuthed.stringifiedClient)
			}

			await Promise.all([secureStore.init(), sqlite.init(), restoreQueries(), cache.restore()])

			if (isAuthed.isAuthed) {
				Promise.allSettled([offline.updateIndex(), offline.sync()]).catch(err => {
					console.error(err)
					alerts.error(err)
				})
			}

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
