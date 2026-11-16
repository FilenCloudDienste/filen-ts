import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as mupdf from "mupdf"
import { FALLBACK_FAMILIES } from "../../core/pdfwrite/fonts/faces.generated"
import type { MupdfModule } from "../../dom/pdfedit/protocol"
import { hanFamily, readFontFamily, SCRIPT_FAMILY, type ReadFontSource } from "../../dom/pdfedit/readFonts"
import { localEngine, stopLocalEngines } from "./localEngine"
import { makeEpub } from "./readFixtures"

afterEach(stopLocalEngines)

const ASSETS = new URL("../../../assets/fonts/", import.meta.url)
const LAYOUT = { width: 400, height: 600, em: 11 }

function nodeFonts(fetched: string[]): ReadFontSource {
	return {
		fetchSync: file => {
			fetched.push(file)

			return new Uint8Array(readFileSync(new URL(file, ASSETS)))
		}
	}
}

describe("the read role's fallback faces", () => {
	it("maps every script MuPDF names to a bundled family, and every bundled text family is reached", () => {
		const ids = new Set(FALLBACK_FAMILIES.map(family => family.id))

		for (const id of Object.values(SCRIPT_FAMILY)) expect(ids.has(id)).toBe(true)

		const reached = new Set(Object.values(SCRIPT_FAMILY))
		const symbols = new Set(["noto-sans-symbols-2", "noto-sans-math"])

		for (const family of FALLBACK_FAMILIES) expect(reached.has(family.id) || symbols.has(family.id)).toBe(true)

		expect(readFontFamily("Latin", undefined)).toBeNull()
		expect(readFontFamily("toString", undefined)).toBeNull()
		expect(readFontFamily("JP", "zh-TW")?.id).toBe("noto-sans-jp")
	})

	it("picks the Han face for MuPDF's TC by the book's language, Simplified Chinese otherwise", () => {
		expect(hanFamily("ja")).toBe("noto-sans-jp")
		expect(hanFamily("ja-JP")).toBe("noto-sans-jp")
		expect(hanFamily("ko")).toBe("noto-sans-kr")
		expect(hanFamily("zh-Hant")).toBe("noto-sans-tc")
		expect(hanFamily("zh-TW")).toBe("noto-sans-tc")
		expect(hanFamily("zh_HK")).toBe("noto-sans-tc")
		expect(hanFamily("zh-Hant-MO")).toBe("noto-sans-tc")
		expect(hanFamily("zh-MO")).toBe("noto-sans-tc")
		expect(hanFamily("zh")).toBe("noto-sans-sc")
		expect(hanFamily("zh-CN")).toBe("noto-sans-sc")
		expect(hanFamily("en")).toBe("noto-sans-sc")
		expect(hanFamily(undefined)).toBe("noto-sans-sc")
		expect(readFontFamily("TC", "zh-TW")?.id).toBe("noto-sans-tc")
		expect(readFontFamily("TC", undefined)?.id).toBe("noto-sans-sc")
	})

	it("fetches the faces a book's text needs once each, and draws with them", async () => {
		const fetched: string[] = []
		const client = localEngine({ readFonts: nodeFonts(fetched) })

		await client.call("open", { bytes: makeEpub(), role: "read", format: "epub", layout: LAYOUT, maxImagePixels: 1e12 })

		const pages = await client.call("pages", { from: 0, count: 1000, generation: 0 })

		for (let page = 0; page < pages.length; page++)
			await client.call("render", { page, scale: 1, rotation: 0, tile: [0, 0, 400, 600], priority: "visible", generation: 0 })

		expect(fetched).toContain("noto/noto-sans-jp/NotoSansJP-Regular.ttf.gz")
		expect(fetched).toContain("noto/noto-sans-hebrew/NotoSansHebrew-Regular.ttf.gz")
		expect(new Set(fetched).size).toBe(fetched.length)
	})

	it("is installed by the read role's open alone and removed on close", async () => {
		const install = vi.fn(mupdf.installLoadFontFunction)
		const module: MupdfModule = { ...mupdf, installLoadFontFunction: install }
		const client = localEngine({ readFonts: nodeFonts([]) }, module)

		await expect(client.call("open", { bytes: new Uint8Array(8), role: "edit" })).rejects.toThrow()
		expect(install).not.toHaveBeenCalled()

		await client.call("open", { bytes: makeEpub(), role: "read", format: "epub", maxImagePixels: 1e12 })
		expect(install).toHaveBeenCalledOnce()

		await client.call("close", {})
		expect(install).toHaveBeenCalledTimes(2)
	})
})
