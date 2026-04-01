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

	public async setup(options?: { background?: boolean }): Promise<{
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

				cache.rootUuid = isAuthed.stringifiedClient.rootUuid
			}

			if (options?.background) {
				await Promise.all([secureStore.init(), sqlite.init(), cache.restore()])
			} else {
				await Promise.all([secureStore.init(), sqlite.init(), cache.restore(), restoreQueries()])

				if (isAuthed.isAuthed) {
					// TODO: Move to host component like camera upload
					Promise.all([offline.updateIndex(), offline.sync()]).catch(err => {
						console.error(err)
						alerts.error(err)
					})
				}
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
