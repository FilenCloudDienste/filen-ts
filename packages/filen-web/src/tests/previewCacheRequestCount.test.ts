// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import type { AnyFile, LinkedFile } from "@filen/sdk-rs"
import "@/lib/i18n"

// Request counts for the session preview cache (previewCache.ts): what a remounted viewer, a public
// Download and a retry each send to the worker. The byte budget is shrunk to 100 bytes so eviction by
// size is exercised with tiny buffers.

const {
	downloadFileBytes,
	downloadLinkedFileBytesAnon,
	downloadLinkedFileToWriterAnon,
	cancelPreviewDownload,
	registerWithSw,
	transformHeicBytes
} = vi.hoisted(() => ({
	downloadFileBytes: vi.fn<(file: AnyFile, token: string) => Promise<Uint8Array>>(),
	downloadLinkedFileBytesAnon: vi.fn<(file: AnyFile, token: string) => Promise<Uint8Array>>(),
	downloadLinkedFileToWriterAnon: vi.fn<() => Promise<void>>(),
	cancelPreviewDownload: vi.fn(),
	registerWithSw: vi.fn<(type: string, payload: Record<string, unknown>) => Promise<void>>(),
	transformHeicBytes: vi.fn<(bytes: Uint8Array) => Promise<Blob>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { downloadFileBytes, downloadLinkedFileBytesAnon, downloadLinkedFileToWriterAnon, cancelPreviewDownload },
	threadCount: () => 1
}))
vi.mock("@/features/drive/lib/preview.logic", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/preview.logic")>()),
	PREVIEW_MAX_BYTES: 100n
}))
vi.mock("@/features/drive/lib/saveDownload", () => ({
	registerWithSw,
	isFsaAvailable: () => typeof window.showSaveFilePicker === "function",
	isPickerCancelled: () => false
}))
vi.mock("@/features/preview/lib/heicTransform", () => ({ transformHeicBytes }))

const createObjectURL = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:test")

const { usePreviewBytes } = await import("@/features/preview/hooks/usePreviewBytes")
const { usePreviewStreamUrl } = await import("@/features/preview/hooks/usePreviewStreamUrl")
const { PreviewAccessModeProvider } = await import("@/features/preview/lib/accessMode")
const { clearPreviewCache, getPreviewBytes } = await import("@/features/preview/lib/previewCache")
const { ImageViewer } = await import("@/features/preview/components/imageViewer")
const { FileHero } = await import("@/features/publicLinks/components/fileHero")
const { startAnonFileDownload } = await import("@/features/publicLinks/lib/download")
const { linkedFileIntoDriveItem } = await import("@/features/drive/lib/item")
const { narrowToAnyFile } = await import("@/features/drive/lib/download")

type DriveItem = ReturnType<typeof linkedFileIntoDriveItem>

function makeItem(uuid: LinkedFile["uuid"], name: string, size: number): DriveItem {
	const file: LinkedFile = {
		uuid,
		name: { Decrypted: name },
		mime: { Decrypted: "application/octet-stream" },
		size: BigInt(size),
		chunks: 1n,
		region: "",
		bucket: "",
		version: 2,
		timestamp: 0n,
		fileKey: "k",
		linkedTag: true,
		canMakeThumbnail: false
	}

	return linkedFileIntoDriveItem(file)
}

// Every download answers a fresh buffer of the file's own size.
function answerBySize(file: AnyFile): Promise<Uint8Array> {
	return Promise.resolve(new Uint8Array(Number(file.size)).fill(7))
}

function nth(items: DriveItem[], index: number): DriveItem {
	const item = items[index]

	if (item === undefined) {
		throw new Error(`no item at ${String(index)}`)
	}

	return item
}

function uuidsOf(spy: typeof downloadFileBytes): string[] {
	return spy.mock.calls.map(([file]) => file.uuid)
}

function Probe({ item }: { item: DriveItem }) {
	const result = usePreviewBytes(item)

	return createElement("span", { "data-testid": "status" }, result.status)
}

// Mirrors the overlay: each pager step remounts the viewer, keyed by the item uuid.
function renderPager(wrapper?: (props: { children: ReactNode }) => ReactNode) {
	const view = render(createElement("div"))

	return async (item: DriveItem) => {
		const probe = createElement(Probe, { key: item.data.uuid, item })

		view.rerender(wrapper === undefined ? probe : createElement(wrapper, null, probe))

		await waitFor(() => {
			expect(screen.getByTestId("status").textContent).toBe("success")
		})
	}
}

const A = makeItem("aaaaaaaa-0000-0000-0000-000000000001", "a.txt", 10)
const B = makeItem("bbbbbbbb-0000-0000-0000-000000000002", "b.txt", 10)

beforeEach(() => {
	clearPreviewCache()
	vi.clearAllMocks()
	cancelPreviewDownload.mockReset()
	downloadFileBytes.mockImplementation(answerBySize)
	downloadLinkedFileBytesAnon.mockImplementation(answerBySize)
	registerWithSw.mockResolvedValue(undefined)
	URL.createObjectURL = createObjectURL
	URL.revokeObjectURL = vi.fn()
	// saveBlob's anchor click would otherwise attempt a jsdom navigation.
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
})

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
	Reflect.deleteProperty(window, "showSaveFilePicker")
})

describe("preview pager revisits", () => {
	it("A→B→A→B→A downloads each file once", async () => {
		const step = renderPager()

		for (const item of [A, B, A, B, A]) {
			await step(item)
		}

		expect(uuidsOf(downloadFileBytes)).toEqual([A.data.uuid, B.data.uuid])
	})

	it("a revisited slot renders its bytes on the first paint, with no pending state", async () => {
		const step = renderPager()

		await step(A)

		const { result } = renderHook(() => usePreviewBytes(A))

		expect(result.current.status).toBe("success")
	})

	it("evicts the least recently used entry past the entry cap", async () => {
		const items = [1, 2, 3, 4, 5].map(n => makeItem(`0000000${String(n)}-0000-0000-0000-000000000000` as const, `${String(n)}.txt`, 1))
		const step = renderPager()

		for (const item of items) {
			await step(item)
		}

		// Five loaded into four slots: the first went, the last four stayed.
		await step(nth(items, 1))
		expect(downloadFileBytes).toHaveBeenCalledTimes(5)

		await step(nth(items, 0))
		expect(downloadFileBytes).toHaveBeenCalledTimes(6)
	})

	it("evicts by total bytes, and never holds a file larger than the whole budget", async () => {
		const big1 = makeItem("99999999-0000-0000-0000-000000000001", "big1.bin", 60)
		const big2 = makeItem("99999999-0000-0000-0000-000000000002", "big2.bin", 60)
		const huge = makeItem("99999999-0000-0000-0000-000000000003", "huge.bin", 150)
		const step = renderPager()

		await step(big1)
		await step(big2)
		// 60 + 60 exceeds the 100-byte budget, so loading big2 dropped big1.
		await step(big1)
		expect(uuidsOf(downloadFileBytes)).toEqual([big1.data.uuid, big2.data.uuid, big1.data.uuid])

		await step(huge)
		await step(big2)
		await step(huge)
		expect(uuidsOf(downloadFileBytes).filter(uuid => uuid === huge.data.uuid)).toHaveLength(2)
	})

	it("a failed load is not cached: the retry downloads, and only its success is reused", async () => {
		downloadFileBytes.mockRejectedValueOnce(new Error("network down"))

		const { result, unmount } = renderHook(() => usePreviewBytes(A))

		await waitFor(() => {
			expect(result.current.status).toBe("error")
		})

		act(() => {
			result.current.refetch()
		})

		await waitFor(() => {
			expect(result.current.status).toBe("success")
		})
		unmount()

		const again = renderHook(() => usePreviewBytes(A))

		expect(again.result.current.status).toBe("success")
		expect(downloadFileBytes).toHaveBeenCalledTimes(2)
	})

	it("a load that lands after the cache was cleared (overlay close, logout) is not stored", async () => {
		let resolve: (bytes: Uint8Array) => void = () => undefined

		downloadFileBytes.mockImplementationOnce(
			() =>
				new Promise<Uint8Array>(r => {
					resolve = r
				})
		)

		const first = renderHook(() => usePreviewBytes(A))

		await waitFor(() => {
			expect(downloadFileBytes).toHaveBeenCalledTimes(1)
		})
		clearPreviewCache()
		resolve(new Uint8Array(10))
		await waitFor(() => {
			expect(first.result.current.status).toBe("success")
		})
		first.unmount()

		renderHook(() => usePreviewBytes(A))

		await waitFor(() => {
			expect(downloadFileBytes).toHaveBeenCalledTimes(2)
		})
	})

	it("clearing empties the cache", async () => {
		const step = renderPager()

		await step(A)
		clearPreviewCache()
		await step(B)
		await step(A)

		expect(uuidsOf(downloadFileBytes)).toEqual([A.data.uuid, B.data.uuid, A.data.uuid])
	})

	it("a revisited HEIC reuses its converted JPEG as well as its bytes", async () => {
		transformHeicBytes.mockResolvedValue(new Blob(["jpeg"]))

		const heic = makeItem("eeeeeeee-0000-0000-0000-000000000001", "photo.heic", 10)

		for (let visit = 0; visit < 2; visit++) {
			const view = render(createElement(ImageViewer, { item: heic, alt: "photo" }))

			await waitFor(() => {
				expect(view.container.querySelector("img")).not.toBeNull()
			})
			view.unmount()
		}

		expect(downloadFileBytes).toHaveBeenCalledTimes(1)
		expect(transformHeicBytes).toHaveBeenCalledTimes(1)
	})
})

describe("streamed preview revisits", () => {
	function registeredIds(): unknown[] {
		return registerWithSw.mock.calls.map(([, payload]) => payload["id"])
	}

	it("re-registers the same id on a revisit, so the element gets the same URL", async () => {
		const first = renderHook(() => usePreviewStreamUrl(A, "a.mp4", "video/mp4"))

		await waitFor(() => {
			expect(first.result.current.status).toBe("success")
		})

		const firstUrl = first.result.current.status === "success" ? first.result.current.url : null

		first.unmount()

		const second = renderHook(() => usePreviewStreamUrl(A, "a.mp4", "video/mp4"))

		await waitFor(() => {
			expect(second.result.current.status).toBe("success")
		})

		expect(second.result.current.status === "success" ? second.result.current.url : null).toBe(firstUrl)
		expect(registerWithSw).toHaveBeenCalledTimes(2)
		expect(new Set(registeredIds()).size).toBe(1)
	})

	it("a retry registers a fresh id", async () => {
		const { result } = renderHook(() => usePreviewStreamUrl(A, "a.mp4", "video/mp4"))

		await waitFor(() => {
			expect(result.current.status).toBe("success")
		})

		act(() => {
			result.current.refetch()
		})

		await waitFor(() => {
			expect(registerWithSw).toHaveBeenCalledTimes(2)
		})
		expect(new Set(registeredIds()).size).toBe(2)
	})
})

describe("public link preview then Download", () => {
	const photo = makeItem("ffffffff-0000-0000-0000-000000000001", "photo.jpg", 10)

	async function renderHeroWithPreview(linkScope: string): Promise<void> {
		render(createElement(FileHero, { item: photo, downloadEnabled: true, linkScope }))

		await waitFor(() => {
			expect(document.querySelector("img")).not.toBeNull()
		})
	}

	it("buffered (no File System Access): saves the previewed bytes instead of downloading again", async () => {
		await renderHeroWithPreview("scope-1")
		expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(1)

		const previewed = (await downloadLinkedFileBytesAnon.mock.results[0]?.value) as Uint8Array

		createObjectURL.mockClear()
		fireEvent.click(screen.getByRole("button", { name: /download/i }))

		await waitFor(() => {
			expect(createObjectURL).toHaveBeenCalledTimes(1)
		})

		const saved = createObjectURL.mock.calls[0]?.[0] as Blob

		expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(1)
		expect(new Uint8Array(await saved.arrayBuffer())).toEqual(previewed)
	})

	it("File System Access: writes the previewed bytes to the picked file instead of streaming it again", async () => {
		const write = vi.fn(() => Promise.resolve())
		const close = vi.fn(() => Promise.resolve())

		await renderHeroWithPreview("scope-1")

		Object.defineProperty(window, "showSaveFilePicker", {
			configurable: true,
			value: () => Promise.resolve({ createWritable: () => Promise.resolve({ write, close, abort: vi.fn() }) })
		})

		fireEvent.click(screen.getByRole("button", { name: /download/i }))

		await waitFor(() => {
			expect(close).toHaveBeenCalledTimes(1)
		})
		expect(write).toHaveBeenCalledTimes(1)
		expect(downloadLinkedFileToWriterAnon).not.toHaveBeenCalled()
		expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(1)
	})

	it("never reuses bytes previewed under a different link password", async () => {
		const previewUnder = (linkScope: string) =>
			renderHook(() => usePreviewBytes(photo), {
				wrapper: ({ children }: { children: ReactNode }) =>
					createElement(PreviewAccessModeProvider, { mode: "anon", linkScope, children })
			})

		const first = previewUnder("password-a")

		await waitFor(() => {
			expect(first.result.current.status).toBe("success")
		})

		const second = previewUnder("password-b")

		await waitFor(() => {
			expect(second.result.current.status).toBe("success")
		})
		expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(2)

		const outcome = await startAnonFileDownload({
			file: narrowToAnyFile(photo),
			name: "photo.jpg",
			size: 10n,
			linkScope: "password-c",
			onProgress: () => undefined
		})

		expect(outcome.status).toBe("success")
		expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(3)
	})

	it("an anon preview with no link scope caches nothing", async () => {
		const wrapper = ({ children }: { children: ReactNode }) => createElement(PreviewAccessModeProvider, { mode: "anon", children })

		for (let visit = 0; visit < 2; visit++) {
			const { result, unmount } = renderHook(() => usePreviewBytes(photo), { wrapper })

			await waitFor(() => {
				expect(result.current.status).toBe("success")
			})
			unmount()
		}

		expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(2)
	})
})

describe("a Download while the preview is still loading", () => {
	const photo = makeItem("ffffffff-0000-0000-0000-000000000002", "photo.jpg", 10)
	const anon = ({ children }: { children: ReactNode }) =>
		createElement(PreviewAccessModeProvider, { mode: "anon", linkScope: "scope-1", children })

	function download(item: DriveItem = photo) {
		return startAnonFileDownload({
			file: narrowToAnyFile(item),
			name: "download.bin",
			size: item.data.size,
			linkScope: "scope-1",
			onProgress: () => undefined
		})
	}

	// The first transfer (the preview's) waits until the test settles it, or rejects once its own token
	// is cancelled, the way the worker's previewAborts registry does.
	function holdFirstTransfer(): { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void } {
		const handle = { resolve: (_bytes: Uint8Array): void => undefined, reject: (_error: Error): void => undefined }

		downloadLinkedFileBytesAnon.mockImplementationOnce(
			(_file, token) =>
				new Promise<Uint8Array>((resolve, reject) => {
					handle.resolve = resolve
					handle.reject = reject
					cancelPreviewDownload.mockImplementation((cancelled: string) => {
						if (cancelled === token) {
							reject(new Error("Cancelled"))
						}
					})
				})
		)

		return handle
	}

	async function savedBytes(): Promise<Uint8Array> {
		await waitFor(() => {
			expect(createObjectURL).toHaveBeenCalledTimes(1)
		})

		return new Uint8Array(await (createObjectURL.mock.calls[0]?.[0] as Blob).arrayBuffer())
	}

	it("buffered: joins the preview's load, one transfer in total", async () => {
		const first = holdFirstTransfer()
		const preview = renderHook(() => usePreviewBytes(photo), { wrapper: anon })

		await waitFor(() => {
			expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(1)
		})

		const outcome = download()

		first.resolve(new Uint8Array(10).fill(3))

		await expect(outcome).resolves.toEqual({ status: "success" })
		await waitFor(() => {
			expect(preview.result.current.status).toBe("success")
		})
		expect(await savedBytes()).toEqual(new Uint8Array(10).fill(3))
		expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(1)
	})

	it("File System Access: writes the joined bytes instead of streaming the file", async () => {
		const write = vi.fn(() => Promise.resolve())
		const close = vi.fn(() => Promise.resolve())
		const createWritable = vi.fn(() => Promise.resolve({ write, close, abort: vi.fn() }))

		Object.defineProperty(window, "showSaveFilePicker", {
			configurable: true,
			value: () => Promise.resolve({ createWritable })
		})

		const first = holdFirstTransfer()

		renderHook(() => usePreviewBytes(photo), { wrapper: anon })

		await waitFor(() => {
			expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(1)
		})

		const outcome = download()

		// Past the picker and joined before the preview's transfer lands, not served from the cache after.
		await waitFor(() => {
			expect(createWritable).toHaveBeenCalledTimes(1)
		})
		await new Promise(resolve => setTimeout(resolve, 0))
		first.resolve(new Uint8Array(10))

		await expect(outcome).resolves.toEqual({ status: "success" })
		expect(write).toHaveBeenCalledTimes(1)
		expect(downloadLinkedFileToWriterAnon).not.toHaveBeenCalled()
		expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(1)
	})

	it("the preview being cancelled does not fail the Download that joined it", async () => {
		holdFirstTransfer()

		const preview = renderHook(() => usePreviewBytes(photo), { wrapper: anon })

		await waitFor(() => {
			expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(1)
		})

		const outcome = download()

		// Joined, not started: the only transfer so far is still the preview's.
		await Promise.resolve()
		expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(1)

		// Hide preview / leave the file: the preview's token is cancelled and its transfer rejects.
		preview.unmount()

		await expect(outcome).resolves.toEqual({ status: "success" })
		expect((await savedBytes()).byteLength).toBe(10)
		expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(2)
	})

	it("a failed shared load leaves nothing behind, and the Download's own fetch is not cached either", async () => {
		const first = holdFirstTransfer()
		const preview = renderHook(() => usePreviewBytes(photo), { wrapper: anon })

		await waitFor(() => {
			expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(1)
		})

		const outcome = download()

		first.reject(new Error("network down"))

		await expect(outcome).resolves.toEqual({ status: "success" })
		await waitFor(() => {
			expect(preview.result.current.status).toBe("error")
		})
		preview.unmount()

		const again = renderHook(() => usePreviewBytes(photo), { wrapper: anon })

		expect(again.result.current.status).toBe("pending")
		await waitFor(() => {
			expect(again.result.current.status).toBe("success")
		})
		expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(3)
	})

	// Firefox and Safari always take the buffered path: the saved file must not stay in memory for the
	// rest of the visit, least of all a file nothing will ever preview.
	it("buffered: a Download of a file nobody previewed leaves the cache empty", async () => {
		await expect(download()).resolves.toEqual({ status: "success" })
		expect((await savedBytes()).byteLength).toBe(10)

		const preview = renderHook(() => usePreviewBytes(photo), { wrapper: anon })

		expect(preview.result.current.status).toBe("pending")
		await waitFor(() => {
			expect(preview.result.current.status).toBe("success")
		})
		expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(2)
	})

	it("buffered: a preview opened while the Download runs joins its transfer, and neither keeps the bytes", async () => {
		const first = holdFirstTransfer()
		const outcome = download()

		await waitFor(() => {
			expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(1)
		})

		const preview = renderHook(() => usePreviewBytes(photo), { wrapper: anon })

		first.resolve(new Uint8Array(10).fill(5))

		await expect(outcome).resolves.toEqual({ status: "success" })
		await waitFor(() => {
			expect(preview.result.current.status).toBe("success")
		})
		expect(preview.result.current.status === "success" ? preview.result.current.bytes : null).toEqual(new Uint8Array(10).fill(5))
		expect(await savedBytes()).toEqual(new Uint8Array(10).fill(5))
		expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(1)
		expect(getPreviewBytes("anon:scope-1", photo.data.uuid)).toBeUndefined()
	})

	it("buffered: a preview that joined a Download that failed loads the file on its own", async () => {
		const first = holdFirstTransfer()
		const outcome = download()

		await waitFor(() => {
			expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(1)
		})

		const preview = renderHook(() => usePreviewBytes(photo), { wrapper: anon })

		first.reject(new Error("network down"))

		expect((await outcome).status).toBe("error")
		await waitFor(() => {
			expect(preview.result.current.status).toBe("success")
		})
		expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(2)
		// The retry is the preview's own load, kept for its next visit.
		expect(getPreviewBytes("anon:scope-1", photo.data.uuid)).toBeDefined()
	})

	// Uncached, its buffer is still memory: cached previews make way for it as for a preview's own load,
	// only as far as the budget needs, so a large file never lands on top of a full cache.
	it("buffered: a Download's own fetch makes room for its buffer", async () => {
		const cached = makeItem("ffffffff-0000-0000-0000-000000000003", "cached.jpg", 40)
		const preview = renderHook(() => usePreviewBytes(cached), { wrapper: anon })

		await waitFor(() => {
			expect(preview.result.current.status).toBe("success")
		})

		// 40 held and 50 incoming fit the 100-byte budget.
		await expect(download(makeItem("eeeeeeee-0000-0000-0000-000000000001", "fits.bin", 50))).resolves.toEqual({ status: "success" })
		expect(getPreviewBytes("anon:scope-1", cached.data.uuid)).toBeDefined()

		// 40 held and 70 incoming don't.
		await expect(download(makeItem("eeeeeeee-0000-0000-0000-000000000002", "large.bin", 70))).resolves.toEqual({ status: "success" })
		expect(getPreviewBytes("anon:scope-1", cached.data.uuid)).toBeUndefined()
		expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(3)
	})

	// Its token only cancels a download it started, so a retry begun after it went away could never be
	// stopped: a whole file fetched with no UI, evicting what the cache held.
	it("a preview that joined a load and went away does not restart it when it fails", async () => {
		const first = holdFirstTransfer()
		const owner = renderHook(() => usePreviewBytes(photo), { wrapper: anon })

		await waitFor(() => {
			expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(1)
		})

		// Show, hide, show, hide: each hidden preview had joined the load still running.
		for (let toggle = 0; toggle < 2; toggle++) {
			renderHook(() => usePreviewBytes(photo), { wrapper: anon }).unmount()
		}

		first.reject(new Error("network down"))

		await waitFor(() => {
			expect(owner.result.current.status).toBe("error")
		})
		await new Promise(resolve => setTimeout(resolve, 0))
		expect(downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(1)
	})

	it("two viewers of the same file mounting together share one transfer", async () => {
		const views = [renderHook(() => usePreviewBytes(A)), renderHook(() => usePreviewBytes(A))]

		for (const view of views) {
			await waitFor(() => {
				expect(view.result.current.status).toBe("success")
			})
		}

		expect(downloadFileBytes).toHaveBeenCalledTimes(1)
	})
})

describe("a revisited slot the pager leaves before the first load's cancel lands", () => {
	it("starts nothing after the overlay closed, and caches nothing", async () => {
		const held = { reject: (_error: Error): void => undefined }

		downloadFileBytes.mockImplementationOnce(
			() =>
				new Promise<Uint8Array>((_resolve, reject) => {
					held.reject = reject
				})
		)

		const first = renderHook(() => usePreviewBytes(A))

		await waitFor(() => {
			expect(downloadFileBytes).toHaveBeenCalledTimes(1)
		})

		// Stepped away and straight back: the revisit joins the load its first visit started.
		first.unmount()

		const revisit = renderHook(() => usePreviewBytes(A))

		// Stepped away again, then closed, all before the first visit's cancel reached the worker.
		revisit.unmount()
		clearPreviewCache()
		held.reject(new Error("Cancelled"))

		await new Promise(resolve => setTimeout(resolve, 0))
		expect(downloadFileBytes).toHaveBeenCalledTimes(1)
		expect(getPreviewBytes("authed", A.data.uuid)).toBeUndefined()
	})
})
