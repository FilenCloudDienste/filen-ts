import secureStore from "@/lib/secureStore"
import auth from "@/lib/auth"
import { run, Semaphore } from "@filen/utils"
import { restoreQueries } from "@/queries/client"
import sqlite from "@/lib/sqlite"

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

			await Promise.all([secureStore.init(), sqlite.init(), restoreQueries()])

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
