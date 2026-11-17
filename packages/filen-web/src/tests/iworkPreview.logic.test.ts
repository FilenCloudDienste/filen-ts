import { describe, expect, it, vi } from "vitest"
import type { ArchiveHandle, LeasedOrigin } from "@/features/archive/lib/archiveHandle"
import { packEntries } from "@/tests/support/archiveEntries"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))

const { IWORK_PREVIEW_PATHS, isUnreadablePackage, iworkAppFor, pickIworkPreview } = await import("@/features/iwork/lib/iworkPreview.logic")
const { openIworkPreview } = await import("@/features/iwork/lib/iworkPreview")
const { previewCategoryForExtension } = await import("@/features/drive/lib/preview.logic")

const DIRECT = { type: "direct", packedBytes: 10n } as const

describe("pickIworkPreview", () => {
	it("takes the best rendering the package holds: the '09 PDF, then the larger images first", () => {
		const paths = IWORK_PREVIEW_PATHS.map(({ path }) => path)

		expect(paths).toEqual(["QuickLook/Preview.pdf", "preview.jpg", "preview-web.jpg", "QuickLook/Thumbnail.jpg", "preview-micro.jpg"])

		for (const [index, { path, kind }] of IWORK_PREVIEW_PATHS.entries()) {
			const held = new Set(paths.slice(index))

			expect(pickIworkPreview(candidate => (held.has(candidate) ? candidate : null))).toEqual({ found: path, kind })
		}

		expect(pickIworkPreview(() => null)).toBeNull()
	})

	it("names each document's app, and routes all three to the iWork viewer", () => {
		expect(["pages", "numbers", "key", "pptx"].map(iworkAppFor)).toEqual(["Pages", "Numbers", "Keynote", null])
		expect(["pages", "numbers", "key"].map(previewCategoryForExtension)).toEqual(["iwork", "iwork", "iwork"])
	})

	it("shows the no-preview card for a file that is no readable package, and Retry for anything else", () => {
		expect(
			["ArchiveUnsupported", "ArchiveCorrupt", "ArchiveTooLarge", "ArchivePasswordRequired", "ArchiveWrongPassword"].every(
				isUnreadablePackage
			)
		).toBe(true)
		expect([undefined, "Cancelled", "Network", "ArchiveWorkerDied"].some(isUnreadablePackage)).toBe(false)
	})
})

describe("openIworkPreview", () => {
	// A handle listing `paths` (indexes from 10, sizes from 100), finding an entry by its name at the root.
	function fakeHandle(paths: string[], lease: LeasedOrigin) {
		return {
			id: "h",
			list: vi.fn<ArchiveHandle["list"]>(onBatch => {
				for (const batch of packEntries(
					paths.map((path, index) => ({ path, index: index + 10, size: 100 + index, access: DIRECT }))
				)) {
					onBatch(batch)
				}

				return Promise.resolve({} as Awaited<ReturnType<ArchiveHandle["list"]>>)
			}),
			findByPath: vi.fn<ArchiveHandle["findByPath"]>((store, path) => {
				const found = store.childEntries(0).find(slot => store.name(slot) === path)

				return found ?? null
			}),
			origin: vi.fn<ArchiveHandle["origin"]>(() => Promise.resolve(lease)),
			release: vi.fn()
		}
	}

	function options(signal = new AbortController().signal) {
		return {
			signal,
			onWaiting: () => undefined,
			events: { phase: () => undefined, verified: () => undefined, failed: () => undefined }
		}
	}

	function lease(): LeasedOrigin {
		return { origin: { kind: "bytes", blob: new Blob(), cacheKey: "k" }, release: vi.fn() }
	}

	it("leases the best rendering the listing holds", async () => {
		const handle = fakeHandle(["Index", "preview-micro.jpg", "preview.jpg"], lease())

		await expect(openIworkPreview(handle, options())).resolves.toMatchObject({
			kind: "image",
			index: 12,
			name: "preview.jpg",
			size: 102
		})
		expect(handle.origin).toHaveBeenCalledOnce()
	})

	it("leases nothing from a package without a rendering", async () => {
		const handle = fakeHandle(["Index", "Metadata"], lease())

		await expect(openIworkPreview(handle, options())).resolves.toBeNull()
		expect(handle.origin).not.toHaveBeenCalled()
	})

	it("lets a lease taken after an abort go at once", async () => {
		const abort = new AbortController()
		const taken = lease()
		const handle = fakeHandle(["preview.jpg"], taken)

		handle.origin.mockImplementation(() => {
			abort.abort()

			return Promise.resolve(taken)
		})

		await expect(openIworkPreview(handle, options(abort.signal))).resolves.toBeNull()
		expect(taken.release).toHaveBeenCalledOnce()
	})
})
