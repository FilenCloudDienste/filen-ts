import { beforeEach, describe, expect, it, vi } from "vitest"
import type { File as SdkFile } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"

// Same boundaries as thumbnails.test.ts: the real sdk client imports a Vite `?worker`, and the real
// thumb cache reaches navigator.storage. A fresh module per file keeps the service's module state
// (urls, verdicts, the reuse queue) apart from that suite's.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/features/drive/lib/thumbCache", () => ({ readThumbnailBlob: vi.fn(), deleteThumbnail: vi.fn() }))

import {
	getThumbnailUrl,
	reuseCopiedThumbnails,
	withGenerationSlot,
	type ThumbGenerationResult,
	type ThumbnailServiceDeps
} from "@/features/drive/lib/thumbnails"
import type { ThumbnailCopy } from "@/features/drive/lib/thumbnails.logic"
import { testUuid } from "@/tests/support/uuid"

let uuidCounter = 0

function imageItem(name = "photo.jpg", mime = "image/jpeg"): DriveItem {
	uuidCounter += 1

	const file: SdkFile = {
		uuid: testUuid(`r${uuidCounter.toString()}`),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name, mime, modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		}
	}

	return narrowItem(file)
}

function pdfItem(): DriveItem {
	return imageItem("doc.pdf", "application/pdf")
}

function makeDeps(overrides: Partial<ThumbnailServiceDeps> = {}): ThumbnailServiceDeps {
	let urlCounter = 0

	return {
		readThumbnailBlob: vi.fn().mockResolvedValue(null),
		deleteThumbnail: vi.fn().mockResolvedValue(undefined),
		storeThumbnail: vi.fn().mockResolvedValue(undefined),
		copyThumbnails: vi.fn().mockResolvedValue(undefined),
		createObjectUrl: vi.fn(() => {
			urlCounter += 1

			return `blob:reuse-${urlCounter.toString()}`
		}),
		revokeObjectUrl: vi.fn(),
		getGenerator: vi.fn().mockReturnValue(undefined),
		...overrides
	}
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve()
	}
}

function copyOf(from: DriveItem, to: DriveItem): ThumbnailCopy {
	return { from: from.data.uuid, to: to.data.uuid }
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("reuseCopiedThumbnails", () => {
	it("copies the source's cached bytes to the copy, and a row asking meanwhile reads that copy", async () => {
		const source = imageItem()
		const copy = imageItem()
		const { promise: copied, resolve: finishCopy } = Promise.withResolvers<undefined>()
		const generator = vi.fn<() => Promise<ThumbGenerationResult>>()
		const deps = makeDeps({
			copyThumbnails: vi.fn(() => copied),
			readThumbnailBlob: vi.fn((uuid: string) => Promise.resolve(uuid === copy.data.uuid ? new Blob([new Uint8Array([1])]) : null)),
			getGenerator: vi.fn().mockReturnValue(generator)
		})

		reuseCopiedThumbnails([copyOf(source, copy)], deps)

		const url = getThumbnailUrl(copy, deps)

		await flushMicrotasks()

		expect(deps.copyThumbnails).toHaveBeenCalledWith([copyOf(source, copy)])
		// Not read yet: the copy is still landing.
		expect(deps.readThumbnailBlob).not.toHaveBeenCalled()

		finishCopy(undefined)

		await expect(url).resolves.toBe("blob:reuse-1")
		expect(generator).not.toHaveBeenCalled()
	})

	it("carries a settled verdict over to the copy without touching the worker", async () => {
		const source = imageItem()
		const copy = imageItem()
		const generator = vi.fn<() => Promise<ThumbGenerationResult>>().mockResolvedValue({ type: "unavailable", reason: "corrupt" })
		const deps = makeDeps({ getGenerator: vi.fn().mockReturnValue(generator) })

		await expect(getThumbnailUrl(source, deps)).resolves.toBeNull()

		reuseCopiedThumbnails([copyOf(source, copy)], deps)

		await expect(getThumbnailUrl(copy, deps)).resolves.toBeNull()
		expect(generator).toHaveBeenCalledTimes(1)
		expect(deps.copyThumbnails).not.toHaveBeenCalled()
	})

	it("leaves a copy whose source has nothing cached to the ordinary path", async () => {
		const source = imageItem()
		const copy = imageItem()
		const generator = vi.fn<() => Promise<ThumbGenerationResult>>().mockResolvedValue({ type: "bytes", bytes: new Uint8Array([4]) })
		const deps = makeDeps({ copyThumbnails: vi.fn().mockResolvedValue(undefined), getGenerator: vi.fn().mockReturnValue(generator) })

		reuseCopiedThumbnails([copyOf(source, copy)], deps)

		await expect(getThumbnailUrl(copy, deps)).resolves.not.toBeNull()
		expect(generator).toHaveBeenCalledTimes(1)
		expect(deps.storeThumbnail).toHaveBeenCalledTimes(1)
	})

	it("skips a copy that already has a rendered thumbnail", async () => {
		const source = imageItem()
		const copy = imageItem()
		const deps = makeDeps({
			getGenerator: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ type: "bytes", bytes: new Uint8Array([4]) }))
		})

		await getThumbnailUrl(copy, deps)

		reuseCopiedThumbnails([copyOf(source, copy)], deps)

		await flushMicrotasks()

		expect(deps.copyThumbnails).not.toHaveBeenCalled()
	})

	it("hands a large job to the worker in bounded batches, one at a time", async () => {
		let inFlight = 0
		let maxInFlight = 0
		const sizes: number[] = []
		const deps = makeDeps({
			copyThumbnails: vi.fn(async (copies: ThumbnailCopy[]) => {
				inFlight += 1
				maxInFlight = Math.max(maxInFlight, inFlight)
				sizes.push(copies.length)

				await flushMicrotasks()

				inFlight -= 1
			})
		})
		const copies = Array.from({ length: 600 }, () => copyOf(imageItem(), imageItem()))

		reuseCopiedThumbnails(copies.slice(0, 300), deps)
		reuseCopiedThumbnails(copies.slice(300), deps)

		await vi.waitFor(() => {
			expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(600)
		})
		expect(maxInFlight).toBe(1)
		expect(Math.max(...sizes)).toBeLessThanOrEqual(256)
	})
})

describe("withGenerationSlot", () => {
	// Generations of `items` held open until each is released.
	async function hold(items: DriveItem[]) {
		const releases: (() => void)[] = []
		const deps = makeDeps({
			getGenerator: vi.fn().mockReturnValue(
				() =>
					new Promise<ThumbGenerationResult>(resolve => {
						releases.push(() => {
							resolve({ type: "failed" })
						})
					})
			)
		})
		const holding = items.map(item => getThumbnailUrl(item, deps))

		await flushMicrotasks()

		return {
			releases,
			done: async (): Promise<void> => {
				for (const release of releases) {
					release()
				}

				await Promise.all(holding)
			}
		}
	}

	it("waits for one of the three browser generation slots", async () => {
		const held = await hold([pdfItem(), pdfItem(), pdfItem()])
		const produce = vi.fn(() => Promise.resolve("done"))
		const slotted = withGenerationSlot("video", produce)

		await flushMicrotasks()

		expect(produce).not.toHaveBeenCalled()

		held.releases[0]?.()

		await expect(slotted).resolves.toBe("done")
		await held.done()
	})

	it("waits for the SDK's decoder, and only for it", async () => {
		const browser = await hold([pdfItem(), pdfItem(), pdfItem()])
		const image = await hold([imageItem()])

		expect(image.releases).toHaveLength(1)

		const produce = vi.fn(() => Promise.resolve("done"))
		const slotted = withGenerationSlot("sdk", produce)

		await flushMicrotasks()

		expect(produce).not.toHaveBeenCalled()

		image.releases[0]?.()

		await expect(slotted).resolves.toBe("done")
		await image.done()
		await browser.done()
	})
})
