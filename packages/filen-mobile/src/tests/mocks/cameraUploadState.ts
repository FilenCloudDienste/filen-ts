import { vi } from "vitest"

/**
 * Map-backed fake of `@/features/cameraUpload/cameraUploadState` for Vitest.
 *
 * A passthrough over the store contract: plain Maps plus functions that read and write them, so suites
 * seed through `.hashes` / `.aborts` and assert through the same methods production calls. Complete,
 * INCLUDING the aborts map, or the post-upload `deleteAbort` throws a swallowed TypeError on every
 * successful upload. Use:
 *
 *   vi.mock("@/features/cameraUpload/cameraUploadState", async () => await import("@/tests/mocks/cameraUploadState"))
 */

const hashes = new Map<string, unknown>()
const aborts = new Map<string, number>()
// The shield is scoped to one remote directory, so the fake tracks it the same way; a bare stub would
// make every pass look like "never recorded".
const destination: { current: string | null } = { current: null }

export default {
	hashes,
	aborts,
	destination,
	loadHashes: async () => {},
	loadAborts: async () => {},
	getHashSync: (key: string) => hashes.get(key),
	getSyncedDestination: async () => destination.current,
	setSyncedDestination: async (uuid: string) => {
		destination.current = uuid
	},
	clearHashes: vi.fn(async () => {
		hashes.clear()
	}),
	getHashMany: async (keys: string[]) => {
		const found = new Map<string, unknown>()

		for (const key of keys) {
			const value = hashes.get(key)

			if (value !== undefined) {
				found.set(key, value)
			}
		}

		return found
	},
	getHash: async (key: string) => hashes.get(key),
	hashKeys: () => [...hashes.keys()],
	setHash: async (key: string, entry: unknown) => {
		hashes.set(key, entry)
	},
	getAbort: (id: string) => aborts.get(id),
	setAbort: async (id: string, count: number) => {
		aborts.set(id, count)
	},
	deleteAbort: async (id: string) => {
		aborts.delete(id)
	},
	applyHashBatch: async ({ upserts, deletes }: { upserts?: [string, unknown][]; deletes?: string[] }) => {
		for (const [key, value] of upserts ?? []) {
			hashes.set(key, value)
		}

		for (const key of deletes ?? []) {
			hashes.delete(key)
		}
	}
}
