import { describe, expect, it, vi } from "vitest"
import { DrawingList } from "../core/drawingml/displayList"
import { conversionBytes, MAX_CACHED_METAFILE_BYTES, MAX_CACHED_METAFILES, MetafileCache } from "../core/metafile/cache"
import type { MetafileConversion } from "../core/metafile/types"

// A conversion whose one embedded bitmap holds `imageBytes` bytes.
function conversion(imageBytes: number): MetafileConversion {
	const list = new DrawingList()

	list.image({
		partName: undefined,
		format: "bmp",
		handling: "native",
		svgPartName: undefined,
		crop: { left: 0, top: 0, right: 0, bottom: 0 },
		alpha: 1,
		grayscale: false,
		biLevel: -1,
		duotone: null,
		brightness: 0,
		contrast: 0,
		colorChange: null,
		bytes: new Uint8Array(imageBytes)
	})

	return { ok: true, format: "emf", list, frame: [0, 0, 1, 1], unsupported: 0, truncated: false }
}

// A cache whose loads resolve to the sizes `sizes` names (1 KiB when unnamed), counting each part's loads.
function cache(sizes: Record<string, number> = {}): { cache: MetafileCache; loads: Map<string, number> } {
	const loads = new Map<string, number>()
	const load = (partName: string): Promise<MetafileConversion | undefined> => {
		loads.set(partName, (loads.get(partName) ?? 0) + 1)

		return Promise.resolve(conversion(sizes[partName] ?? 1024))
	}

	return { cache: new MetafileCache(load), loads }
}

// Lets the cache's resolve handlers run.
async function settle(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0))
}

describe("MetafileCache", () => {
	it("serves a part from one load and keeps the most recently used when over its count", async () => {
		const { cache: metafiles, loads } = cache()

		for (let k = 0; k < MAX_CACHED_METAFILES; k++) await metafiles.get(`p${String(k)}`)

		// A hit makes p0 the most recent: p1 is now the oldest and goes first.
		expect(await metafiles.get("p0")).toBeDefined()
		await metafiles.get("extra")
		await settle()
		await metafiles.get("p0")
		await metafiles.get("p1")

		expect(loads.get("p0")).toBe(1)
		expect(loads.get("p1")).toBe(2)
	})

	it("evicts the oldest entries when their bytes are over the budget", async () => {
		const quarter = Math.floor(MAX_CACHED_METAFILE_BYTES / 4)
		const { cache: metafiles, loads } = cache({ a: quarter, b: quarter, c: quarter, d: quarter })

		for (const part of ["a", "b", "c", "d"]) await metafiles.get(part)

		await settle()
		await metafiles.get("b")
		await metafiles.get("c")
		await metafiles.get("d")

		// The four, with their lists, are over the budget: only the oldest went.
		expect(loads.get("a")).toBe(1)
		expect([loads.get("b"), loads.get("c"), loads.get("d")]).toEqual([1, 1, 1])
		await metafiles.get("a")
		expect(loads.get("a")).toBe(2)
	})

	it("does not keep a conversion larger than the whole budget, and keeps the others", async () => {
		const { cache: metafiles, loads } = cache({ big: MAX_CACHED_METAFILE_BYTES + 1 })

		for (let k = 0; k < 8; k++) await metafiles.get(`small${String(k)}`)

		expect(conversionBytes(await metafiles.get("big"))).toBeGreaterThan(MAX_CACHED_METAFILE_BYTES)
		await settle()

		for (let k = 0; k < 8; k++) await metafiles.get(`small${String(k)}`)

		await metafiles.get("big")

		for (let k = 0; k < 8; k++) expect(loads.get(`small${String(k)}`)).toBe(1)

		expect(loads.get("big")).toBe(2)
	})

	it("drops a load that failed so the next use loads again", async () => {
		const load = vi.fn<(partName: string) => Promise<MetafileConversion | undefined>>()

		load.mockRejectedValueOnce(new Error("unreadable")).mockResolvedValue(conversion(16))

		const metafiles = new MetafileCache(load)

		await expect(metafiles.get("part")).rejects.toThrow("unreadable")
		await settle()
		expect(await metafiles.get("part")).toBeDefined()
		expect(load).toHaveBeenCalledTimes(2)
	})

	it("counts no bytes for a load that resolves after clear()", async () => {
		// Three such conversions fit the budget exactly, a fourth does not.
		const third = Math.floor(MAX_CACHED_METAFILE_BYTES / 3) - conversionBytes(conversion(0))
		let release: (value: MetafileConversion) => void = () => undefined
		const loads = new Map<string, number>()
		const metafiles = new MetafileCache(partName => {
			loads.set(partName, (loads.get(partName) ?? 0) + 1)

			return partName === "slow" ? new Promise(resolve => (release = resolve)) : Promise.resolve(conversion(third))
		})
		const slow = metafiles.get("slow")

		metafiles.clear()
		release(conversion(third))
		await slow
		await settle()

		// Had the stale load counted its bytes, three thirds and it would be over the budget.
		for (const part of ["a", "b", "c"]) await metafiles.get(part)

		await settle()

		for (const part of ["a", "b", "c"]) await metafiles.get(part)

		expect([loads.get("a"), loads.get("b"), loads.get("c")]).toEqual([1, 1, 1])
	})
})
