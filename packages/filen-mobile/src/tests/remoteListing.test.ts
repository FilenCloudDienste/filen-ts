import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

const { mockWalk } = vi.hoisted(() => ({
	mockWalk: vi.fn()
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: async () => ({
			authedSdkClient: {
				listDirRecursiveWithPaths: mockWalk
			}
		})
	}
}))

vi.mock("@filen/sdk-rs", () => ({
	AnyDirWithContext: {
		Normal: class {
			public inner: unknown[]

			public constructor(v: unknown) {
				this.inner = [v]
			}
		}
	}
}))

import {
	listCameraUploadRemote,
	remoteListingPosition,
	remoteWalkDropsEntries,
	SETTLED_REUSE_MS
} from "@/features/cameraUpload/remoteListing"
import type { AnyNormalDir } from "@filen/sdk-rs"

const root = { inner: [{ uuid: "camera-root" }] } as unknown as AnyNormalDir
const otherRoot = { inner: [{ uuid: "other-root" }] } as unknown as AnyNormalDir
const listing = { dirs: [], files: [] }

type Deferred = { resolve: (value: unknown) => void; reject: (error: unknown) => void; signal: AbortSignal }

// Each walk parks until the test settles it, so overlap is under the test's control.
function deferredWalks(): Deferred[] {
	const walks: Deferred[] = []

	mockWalk.mockImplementation(
		(_dir: unknown, _progress: unknown, _errors: unknown, opts: { signal: AbortSignal }) =>
			new Promise((resolve, reject) => {
				walks.push({ resolve, reject, signal: opts.signal })
			})
	)

	return walks
}

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve()
	}
}

beforeEach(() => {
	mockWalk.mockReset()
	mockWalk.mockResolvedValue(listing)
})

afterEach(() => {
	vi.useRealTimers()
})

describe("listCameraUploadRemote", () => {
	it("the grid always walks; a sync that began before that walk takes it over", async () => {
		const syncPosition = remoteListingPosition()

		await listCameraUploadRemote({ remoteDir: root })
		await listCameraUploadRemote({ remoteDir: root, since: syncPosition })

		expect(mockWalk).toHaveBeenCalledTimes(1)

		// A grid refetch never reuses, even right after.
		await listCameraUploadRemote({ remoteDir: root })

		expect(mockWalk).toHaveBeenCalledTimes(2)
	})

	it("a sync joins a walk still in flight (reconnect firing both at once)", async () => {
		const walks = deferredWalks()
		const syncPosition = remoteListingPosition()
		const grid = listCameraUploadRemote({ remoteDir: root })

		await flush()

		const sync = listCameraUploadRemote({ remoteDir: root, since: syncPosition })

		walks[0]?.resolve(listing)

		const [gridResult, syncResult] = await Promise.all([grid, sync])

		expect(mockWalk).toHaveBeenCalledTimes(1)
		expect(syncResult).toBe(gridResult)
	})

	it("a sync never takes over a walk that started before it", async () => {
		await listCameraUploadRemote({ remoteDir: root })
		await listCameraUploadRemote({ remoteDir: root, since: remoteListingPosition() })

		expect(mockWalk).toHaveBeenCalledTimes(2)
	})

	it("a settled walk is only reusable for SETTLED_REUSE_MS", async () => {
		vi.useFakeTimers()

		const syncPosition = remoteListingPosition()

		await listCameraUploadRemote({ remoteDir: root })

		vi.advanceTimersByTime(SETTLED_REUSE_MS + 1)

		await listCameraUploadRemote({ remoteDir: root, since: syncPosition })

		expect(mockWalk).toHaveBeenCalledTimes(2)
	})

	it("a walk of another root is never reused", async () => {
		const syncPosition = remoteListingPosition()

		await listCameraUploadRemote({ remoteDir: otherRoot })
		await listCameraUploadRemote({ remoteDir: root, since: syncPosition })

		expect(mockWalk).toHaveBeenCalledTimes(2)
	})

	it("one consumer aborting leaves the walk running for the other", async () => {
		const walks = deferredWalks()
		const syncPosition = remoteListingPosition()
		const gridController = new AbortController()
		const grid = listCameraUploadRemote({ remoteDir: root, signal: gridController.signal })

		await flush()

		const sync = listCameraUploadRemote({ remoteDir: root, since: syncPosition })

		gridController.abort()

		await expect(grid).rejects.toThrow()

		expect(walks[0]?.signal.aborted).toBe(false)

		walks[0]?.resolve(listing)

		await expect(sync).resolves.toEqual({ listing, scanErrors: [] })
		expect(mockWalk).toHaveBeenCalledTimes(1)
	})

	it("the walk is aborted once every consumer gave up, and is not reused afterwards", async () => {
		const walks = deferredWalks()
		const syncPosition = remoteListingPosition()
		const controller = new AbortController()
		const grid = listCameraUploadRemote({ remoteDir: root, signal: controller.signal })

		await flush()

		controller.abort()

		await expect(grid).rejects.toThrow()

		expect(walks[0]?.signal.aborted).toBe(true)

		const sync = listCameraUploadRemote({ remoteDir: root, since: syncPosition })

		await flush()

		walks[1]?.resolve(listing)

		await sync

		expect(mockWalk).toHaveBeenCalledTimes(2)
	})

	it("scan errors reach every consumer, including ones reported after the walk resolved", async () => {
		const late: { report: (errors: unknown[]) => void } = { report: () => undefined }

		mockWalk.mockImplementation(async (_dir: unknown, _progress: unknown, errorCallback: { onErrors: (errors: unknown[]) => void }) => {
			late.report = errors => errorCallback.onErrors(errors)

			return listing
		})

		const syncPosition = remoteListingPosition()
		const grid = await listCameraUploadRemote({ remoteDir: root })

		late.report([new Error("late")])

		const sync = await listCameraUploadRemote({ remoteDir: root, since: syncPosition })

		expect(grid.scanErrors).toHaveLength(1)
		expect(sync.scanErrors).toBe(grid.scanErrors)
	})

	it("remembers a root whose walk dropped entries until a clean walk of it", async () => {
		mockWalk.mockImplementationOnce(
			async (_dir: unknown, _progress: unknown, errorCallback: { onErrors: (errors: unknown[]) => void }) => {
				errorCallback.onErrors([new Error("duplicate")])

				return listing
			}
		)

		await listCameraUploadRemote({ remoteDir: otherRoot })

		expect(remoteWalkDropsEntries("other-root")).toBe(true)

		await listCameraUploadRemote({ remoteDir: otherRoot })

		expect(remoteWalkDropsEntries("other-root")).toBe(false)
	})
})
