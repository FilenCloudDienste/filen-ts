import { describe, expect, it, vi } from "vitest"
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

describe("fetchFontAssets", () => {
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
})
