import { type } from "arktype"
import { type AtomicFile, errorCode } from "../atomicFile.ts"

// Whether a user switched Filen in Finder on: `<userData>/mounts/<userId>/fileProvider.json`, present only while on.
export interface FileProviderStore {
	enabled(userId: string): Promise<boolean>
	setEnabled(userId: string, enabled: boolean): Promise<void>
}

const recordSchema = type({ version: "1", enabled: "true" })

// Read once per user, served from memory. The caller runs one operation at a time.
export function createFileProviderStore(fileFor: (userId: string) => AtomicFile, warn: (message: string) => void): FileProviderStore {
	const known = new Map<string, boolean>()

	async function read(userId: string): Promise<boolean> {
		let data: Buffer | null

		try {
			data = await fileFor(userId).read()
		} catch (error) {
			warn(`file provider: store unreadable: ${errorCode(error)}`)

			return false
		}

		if (data === null) {
			return false
		}

		let json: unknown

		try {
			json = JSON.parse(data.toString("utf8"))
		} catch {
			json = null
		}

		if (!(recordSchema(json) instanceof type.errors)) {
			return true
		}

		warn("file provider: store is invalid; counted as off")

		return false
	}

	return {
		enabled: async userId => {
			let enabled = known.get(userId)

			if (enabled === undefined) {
				enabled = await read(userId)
				known.set(userId, enabled)
			}

			return enabled
		},
		setEnabled: async (userId, enabled) => {
			if (known.get(userId) === enabled) {
				return
			}

			const file = fileFor(userId)

			if (enabled) {
				await file.write(Buffer.from(JSON.stringify({ version: 1, enabled: true })))
			} else {
				await file.remove()
			}

			known.set(userId, enabled)
		}
	}
}
