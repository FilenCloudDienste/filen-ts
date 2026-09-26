import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { StorageApi } from "@/workers/db.worker"

// db.worker.ts exposes its api through Comlink at load, so the mock captures it rather than a real
// worker. OPFS is an in-memory stand-in: a pool directory of files whose createSyncAccessHandle fails
// with the real lock-conflict DOMException while `lockedProbes` lasts, the way a file still held by a
// previous document's worker does.

const mocks = vi.hoisted(() => ({
	expose: vi.fn(),
	install: vi.fn(),
	warn: vi.fn()
}))

vi.mock("comlink", () => ({ expose: mocks.expose }))
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: mocks.warn, info: vi.fn(), debug: vi.fn() } }))
vi.mock("@sqlite.org/sqlite-wasm", () => ({
	default: () => Promise.resolve({ installOpfsSAHPoolVfs: mocks.install })
}))

const POOL_FILES = 4

let lockedProbes: number
let probes: number
let poolMissing: boolean
let probeError: DOMException | null

function lockConflict(): DOMException {
	return new DOMException("Access Handles cannot be created if there is another open Access Handle", "NoModificationAllowedError")
}

function fileHandle(): { kind: "file"; createSyncAccessHandle: () => Promise<{ close: () => void }> } {
	return {
		kind: "file",
		createSyncAccessHandle: () => {
			probes++

			if (probeError !== null) {
				return Promise.reject(probeError)
			}

			if (lockedProbes > 0) {
				lockedProbes--

				return Promise.reject(lockConflict())
			}

			return Promise.resolve({ close: () => undefined })
		}
	}
}

const poolDirectory = {
	getDirectoryHandle: () => Promise.resolve(poolDirectory),
	values: async function* () {
		for (let i = 0; i < POOL_FILES; i++) {
			yield await Promise.resolve(fileHandle())
		}
	}
}

const root = {
	getDirectoryHandle: () => (poolMissing ? Promise.reject(new DOMException("missing", "NotFoundError")) : Promise.resolve(poolDirectory))
}

class FakeDb {
	public exec(): void {
		// the kv table create is not what these tests are about
	}
}

let api: StorageApi

beforeAll(async () => {
	await import("@/workers/db.worker")
	api = mocks.expose.mock.calls[0]?.[0] as StorageApi
})

beforeEach(() => {
	vi.useFakeTimers()
	vi.stubGlobal("navigator", { storage: { getDirectory: () => Promise.resolve(root) } })
	lockedProbes = 0
	probes = 0
	poolMissing = false
	probeError = null
	mocks.install.mockImplementation(() => Promise.resolve({ OpfsSAHPoolDb: FakeDb }))
})

afterEach(() => {
	vi.useRealTimers()
})

async function open(): Promise<unknown> {
	const opened = api.open().then(
		() => null,
		(e: unknown) => e
	)

	await vi.runAllTimersAsync()

	return await opened
}

describe("db.worker open", () => {
	it("waits out a pool a previous worker still holds, then installs once", async () => {
		lockedProbes = 2

		let probesBeforeInstall = -1

		mocks.install.mockImplementation(() => {
			probesBeforeInstall = probes

			return Promise.resolve({ OpfsSAHPoolDb: FakeDb })
		})

		expect(await open()).toBeNull()
		expect(mocks.install).toHaveBeenCalledTimes(1)
		// two failed probes, then one pass over every file
		expect(probesBeforeInstall).toBe(2 + POOL_FILES)
		expect(mocks.warn).toHaveBeenCalledTimes(2)
	})

	it("stops waiting after its budget and maps the install's lock failure as before", async () => {
		lockedProbes = Number.POSITIVE_INFINITY
		mocks.install.mockImplementation(() => Promise.reject(lockConflict()))

		const error = await open()

		expect(error).toMatchObject({ name: "OpfsUnavailableError" })
		expect(mocks.install).toHaveBeenCalledTimes(1)
		expect(mocks.warn).toHaveBeenCalledTimes(6)
	})

	it("installs straight away on a first run, with no pool to wait for", async () => {
		poolMissing = true

		expect(await open()).toBeNull()
		expect(probes).toBe(0)
		expect(mocks.install).toHaveBeenCalledTimes(1)
		expect(mocks.warn).not.toHaveBeenCalled()
	})

	it("does not retry an error that is not a lock conflict", async () => {
		probeError = new DOMException("denied", "SecurityError")

		expect(await open()).toBeNull()
		expect(probes).toBe(1)
		expect(mocks.install).toHaveBeenCalledTimes(1)
		expect(mocks.warn).not.toHaveBeenCalled()
	})
})
