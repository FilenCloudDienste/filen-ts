import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchFontAssets } from "@filen/office/dom/docx"
import { liveHeap } from "./liveHeap"

const MiB = 1024 * 1024
const FONT_BYTES = 8 * MiB

// Every request answers a font of its own.
function stubFetch(): void {
	vi.stubGlobal("fetch", (_url: string) =>
		Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(FONT_BYTES)) })
	)
}

// A document's fonts, read and let go: a call of its own, so nothing it read is reachable once it returns.
async function readFonts(location: string, shared: boolean): Promise<number> {
	const assets = fetchFontAssets(location, { shared })
	const font = await assets.read("carlito/Carlito-Regular.ttf")

	return font.byteLength
}

type Response = { readonly ok: boolean; readonly status: number; arrayBuffer(): Promise<ArrayBuffer> }

// A counted fetch answering small fonts, or the given responses in order.
function countedFetch(...responses: Response[]) {
	const fetcher = vi.fn((_url: string) =>
		Promise.resolve(responses.shift() ?? { ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)) })
	)

	vi.stubGlobal("fetch", fetcher)

	return fetcher
}

const FILE = "carlito/Carlito-Regular.ttf"

describe("fetchFontAssets", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("holds a page's fonts only as long as its document's assets", async () => {
		stubFetch()

		const before = await liveHeap()

		expect(await readFonts("/page/", false)).toBe(FONT_BYTES)

		expect(((await liveHeap()) - before) / MiB).toBeLessThan(1)
	})

	it("keeps a worker's fonts for its next document", async () => {
		stubFetch()

		const before = await liveHeap()

		expect(await readFonts("/worker/", true)).toBe(FONT_BYTES)

		expect(((await liveHeap()) - before) / MiB).toBeGreaterThan(FONT_BYTES / MiB - 1)
	})

	it("fetches a file once for every read of one assets object", async () => {
		const fetcher = countedFetch()
		const assets = fetchFontAssets("/once/")

		await assets.read(FILE)
		await assets.read(FILE)

		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(fetcher).toHaveBeenCalledWith("/once/carlito/Carlito-Regular.ttf")
	})

	it("fetches a file once for every shared assets object of a location", async () => {
		const fetcher = countedFetch()

		await fetchFontAssets("/shared-once/", { shared: true }).read(FILE)
		await fetchFontAssets("/shared-once/", { shared: true }).read(FILE)

		expect(fetcher).toHaveBeenCalledTimes(1)
	})

	it("fetches a file once for concurrent reads", async () => {
		const fetcher = countedFetch()
		const assets = fetchFontAssets("/concurrent/")

		await Promise.all([assets.read(FILE), assets.read(FILE)])

		expect(fetcher).toHaveBeenCalledTimes(1)
	})

	it("fetches a file again for an assets object that is not shared", async () => {
		const fetcher = countedFetch()

		await fetchFontAssets("/unshared/").read(FILE)
		await fetchFontAssets("/unshared/").read(FILE)

		expect(fetcher).toHaveBeenCalledTimes(2)
	})

	it("forgets a failed fetch so the next read fetches again", async () => {
		const fetcher = countedFetch({ ok: false, status: 500, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) })
		const assets = fetchFontAssets("/retry/", { shared: true })

		await expect(assets.read(FILE)).rejects.toThrow("HTTP 500")
		expect((await assets.read(FILE)).byteLength).toBe(16)
		expect(fetcher).toHaveBeenCalledTimes(2)
	})

	it("gives every read its own copy", async () => {
		countedFetch()
		const assets = fetchFontAssets("/copies/", { shared: true })
		const first = await assets.read(FILE)
		const second = await assets.read(FILE)

		expect(first).not.toBe(second)
		expect(first.buffer).not.toBe(second.buffer)
	})

	it("throws for a file the location does not serve", async () => {
		const fetcher = countedFetch()

		await expect(fetchFontAssets({}).read(FILE)).rejects.toThrow("is not served")
		expect(fetcher).not.toHaveBeenCalled()
	})
})
