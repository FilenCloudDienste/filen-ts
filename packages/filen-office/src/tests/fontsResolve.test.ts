import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
	ARIAL_NARROW_WIDTH_SCALE,
	FontError,
	FontManager,
	LINE_METRICS,
	NO_HINTS,
	UNCALIBRATED_APTOS_SCALE,
	BUNDLED_FACES,
	CLONE_METRICS,
	DEFAULT_FONT_LIMITS,
	DEFAULT_SLOT_CONTEXT,
	declareDocxEmbeddedFonts,
	eastAsiaUsesAscii,
	cssFont,
	fontSlot,
	forEachSlotRun,
	isChineseCharset,
	isChineseLanguage,
	obfuscateFont,
	readDocxFontTable,
	type FontAssets,
	type FontDeclaration,
	type FontFaceDescriptor,
	type FontHints,
	type FontHost,
	type FontRequest,
	type FontSlot,
	type SlotContext
} from "@filen/office/core/fonts"
import { OpcPackage, bytesSource } from "@filen/office/core/opc"
import { parseXml } from "@filen/office/core/xml"
import { fontFaceHost, localSource, type FontFaceScope } from "@filen/office/dom"
import { ASSETS } from "../scripts/fontTables"
import { sfntFromWoff2 } from "../scripts/woff2Tables"
import { buildZip, text } from "./zipBuilder"

function realFont(file: string): Uint8Array {
	return sfntFromWoff2(new Uint8Array(readFileSync(`${ASSETS}${file}`)))
}

class FakeHost implements FontHost {
	readonly faces: { face: FontFaceDescriptor; source: string; bytes: number }[] = []
	readonly removed: string[] = []
	readonly installed: Set<string>
	readonly localCalls: string[] = []
	rejectBytes = false

	constructor(installed: string[] = []) {
		this.installed = new Set(installed)
	}

	addBytes(face: FontFaceDescriptor, data: Uint8Array): Promise<boolean> {
		if (this.rejectBytes) return Promise.resolve(false)

		this.faces.push({ face, source: "bytes", bytes: data.length })

		return Promise.resolve(true)
	}

	addLocal(face: FontFaceDescriptor, name: string): Promise<boolean> {
		this.localCalls.push(name)

		if (!this.installed.has(name)) return Promise.resolve(false)

		this.faces.push({ face, source: `local:${name}`, bytes: 0 })

		return Promise.resolve(true)
	}

	remove(family: string): void {
		this.removed.push(family)
	}
}

class FakeAssets implements FontAssets {
	readonly reads: string[] = []
	failing = new Set<string>()

	read(file: string): Promise<Uint8Array> {
		this.reads.push(file)

		return this.failing.has(file) ? Promise.reject(new Error("missing")) : Promise.resolve(new Uint8Array(16))
	}
}

function request(family: string, options: { bold?: boolean; italic?: boolean; slot?: FontSlot } = {}): FontRequest {
	return { family, bold: options.bold ?? false, italic: options.italic ?? false, slot: options.slot ?? "hAnsi" }
}

async function resolved(manager: FontManager, req: FontRequest) {
	await manager.prepare([req])

	return manager.resolve(req)
}

// Aliases carry a per-manager prefix.
function alias(name: string): unknown {
	return expect.stringMatching(new RegExp(`^fo[0-9a-f]{12}[0-9a-z]+-${name}$`))
}

function declaration(name: string, hints: Partial<FontHints>, altNames: string[] = []): FontDeclaration {
	return { name, altNames, hints: { ...NO_HINTS, ...hints } }
}

describe("substitution", () => {
	it("draws Calibri in Carlito, loading only the face it needs", async () => {
		const host = new FakeHost()
		const assets = new FakeAssets()
		const manager = new FontManager(host, assets)
		const font = await resolved(manager, request("Calibri"))

		expect(font).toMatchObject({
			family: alias("carlito"),
			generic: "sans-serif",
			weight: 400,
			italic: false,
			scale: 1,
			source: "bundled"
		})
		// Calibri's own vertical metrics, as Carlito first published them (the bundled build moved hhea to win).
		expect(font.metricsBasis).toBe("original")
		expect(font.metrics).toMatchObject({ hheaAscender: 1536, hheaDescender: -512, hheaLineGap: 452, winAscent: 1950, winDescent: 550 })
		expect(assets.reads).toEqual(["carlito/Carlito-Regular.woff2"])
		expect(host.faces[0]?.face).toEqual({ family: alias("carlito"), weight: 400, italic: false })

		const boldItalic = await resolved(manager, request("CALIBRI", { bold: true, italic: true }))

		expect(boldItalic).toMatchObject({ family: alias("carlito"), weight: 700, italic: true })
		expect(assets.reads).toContain("carlito/Carlito-BoldItalic.woff2")
		expect(cssFont(boldItalic, 16)).toMatch(/^italic 700 16px "fo[0-9a-f]{12}[0-9a-z]+-carlito", sans-serif$/)
	})

	it("uses published metrics of the original where they exist", async () => {
		const assets = new FakeAssets()
		const manager = new FontManager(new FakeHost(), assets)
		const regular = await resolved(manager, request("Arial"))
		const bold = await resolved(manager, request("Arial", { bold: true }))
		const original = LINE_METRICS.get("arial")

		expect(regular).toMatchObject({ family: alias("arimo"), metricsBasis: "original" })
		expect(original?.basis === "original" ? original.metrics : null).toBe(regular.metrics)
		expect(bold.weight).toBe(700)
		// One variable font serves both weights.
		expect(assets.reads).toEqual(["arimo/Arimo-VF.woff2"])
	})

	it("pins the weight a family name implies", async () => {
		const assets = new FakeAssets()
		const manager = new FontManager(new FakeHost(), assets)

		expect(await resolved(manager, request("Segoe UI Semibold"))).toMatchObject({ family: alias("selawik"), weight: 600 })
		expect(await resolved(manager, request("Segoe UI Semibold", { bold: true }))).toMatchObject({ weight: 700 })
		// Selawik has no italic; the upright face is slanted by the browser.
		expect(await resolved(manager, request("Segoe UI", { italic: true }))).toMatchObject({ weight: 400, italic: true })
		expect(assets.reads).toEqual(["selawik/selawksb.woff2", "selawik/selawkb.woff2", "selawik/selawk.woff2"])
	})

	it("prefers an installed Aptos and otherwise sets Carlito at the calibrated size", async () => {
		const plain = new FontManager(new FakeHost(), new FakeAssets())

		expect(await resolved(plain, request("Aptos"))).toMatchObject({ family: alias("carlito"), scale: UNCALIBRATED_APTOS_SCALE })

		const host = new FakeHost(["Aptos", "Aptos Bold"])
		const installed = new FontManager(host, new FakeAssets())
		const regular = await resolved(installed, request("Aptos"))
		const bold = await resolved(installed, request("Aptos", { bold: true }))
		const italic = await resolved(installed, request("Aptos", { italic: true }))

		expect(regular).toMatchObject({
			family: alias("l1"),
			source: "local",
			metrics: null,
			metricsBasis: "runtime",
			generic: "sans-serif"
		})
		expect(bold).toMatchObject({ family: alias("l1"), weight: 700 })
		// No installed italic: the regular face is slanted, never a substitute mixed in.
		expect(italic).toMatchObject({ family: alias("l1"), italic: true })
		expect(host.localCalls).toEqual(["Aptos", "Aptos Bold", "Aptos Italic"])
	})

	it("prefers an installed Arial Narrow and otherwise narrows Arimo horizontally only", async () => {
		const plain = new FontManager(new FakeHost(), new FakeAssets())

		expect(await resolved(plain, request("Arial Narrow"))).toMatchObject({
			family: alias("arimo"),
			source: "bundled",
			scale: 1,
			widthScale: ARIAL_NARROW_WIDTH_SCALE
		})
		expect(await resolved(plain, request("Arial"))).toMatchObject({ family: alias("arimo"), widthScale: 1 })

		const installed = new FontManager(new FakeHost(["Arial Narrow"]), new FakeAssets())

		expect(await resolved(installed, request("Arial Narrow"))).toMatchObject({ source: "local", widthScale: 1 })
	})

	it("never consults installed fonts for families with a substitute", async () => {
		const host = new FakeHost(["Calibri"])

		expect(await resolved(new FontManager(host, new FakeAssets()), request("Calibri"))).toMatchObject({ source: "bundled" })
		expect(host.localCalls).toEqual([])
	})

	it("follows the font table's alternative names", async () => {
		const manager = new FontManager(new FakeHost(), new FakeAssets())

		manager.declare([declaration("Body Font", { fontClass: "decorative" }, ["Calibri"])])

		expect(await resolved(manager, request("body font"))).toMatchObject({ family: alias("carlito") })
		expect(await resolved(manager, request("calibri"))).toMatchObject({ family: alias("carlito") })
	})
})

describe("fallbacks", () => {
	it("uses an installed font of an unknown family", async () => {
		const manager = new FontManager(new FakeHost(["Comic Neue"]), new FakeAssets())

		expect(await resolved(manager, request("Comic Neue"))).toMatchObject({ source: "local", family: alias("l1") })
	})

	it("picks a bundled family from the font table's hints", async () => {
		const manager = new FontManager(new FakeHost(), new FakeAssets())

		manager.declare([
			declaration("Book", { fontClass: "roman" }),
			declaration("Grotesk", { fontClass: "swiss" }),
			declaration("Typewriter", { pitch: "fixed", fontClass: "roman" }),
			declaration("Panose Sans", { panose: new Uint8Array([2, 11, 5, 2, 2, 2, 2, 2, 2, 4]) }),
			declaration("Panose Mono", { panose: new Uint8Array([2, 7, 3, 9, 2, 2, 5, 2, 4, 4]) }),
			declaration("Mincho", { fontClass: "roman", charset: 0x80 }),
			declaration("MS Gothic", { fontClass: "modern", pitch: "fixed", charset: 0x80 })
		])

		expect(await resolved(manager, request("Book"))).toMatchObject({
			family: alias("tinos"),
			generic: "serif",
			metricsBasis: "substitute"
		})
		expect(await resolved(manager, request("Grotesk"))).toMatchObject({ family: alias("arimo"), generic: "sans-serif" })
		expect(await resolved(manager, request("Typewriter"))).toMatchObject({ family: alias("cousine"), generic: "monospace" })
		expect(await resolved(manager, request("Panose Sans"))).toMatchObject({ family: alias("arimo") })
		expect(await resolved(manager, request("Panose Mono"))).toMatchObject({ family: alias("cousine") })
		// A Japanese font: the platform's fonts have the glyphs, the bundled Latin ones do not.
		expect(await resolved(manager, request("Mincho"))).toMatchObject({ family: null, generic: "serif", source: "generic" })
		expect(await resolved(manager, request("Unknown Sans", { slot: "eastAsia" }))).toMatchObject({
			family: null,
			generic: "sans-serif"
		})
		expect(await resolved(manager, request("Nothing Known"))).toMatchObject({ family: alias("tinos") })
		expect(await resolved(manager, request("MS Gothic"))).toMatchObject({ family: null, generic: "monospace" })
	})

	it("draws with the generic family when a face cannot load or was not prepared", async () => {
		const assets = new FakeAssets()

		assets.failing.add("carlito/Carlito-Regular.woff2")

		const failing = new FontManager(new FakeHost(), assets)

		expect(await resolved(failing, request("Calibri"))).toMatchObject({ family: null, generic: "sans-serif" })

		const unprepared = new FontManager(new FakeHost(), new FakeAssets())

		expect(unprepared.resolve(request("Georgia"))).toMatchObject({ family: null, generic: "serif" })

		const rejecting = new FakeHost()

		rejecting.rejectBytes = true
		expect(await resolved(new FontManager(rejecting, new FakeAssets()), request("Georgia"))).toMatchObject({ source: "generic" })
	})

	it("bounds installed-font probes and never probes unprintable names", async () => {
		const host = new FakeHost(["A", "B"])
		const manager = new FontManager(host, new FakeAssets(), { maxEmbeddedFaceBytes: 1, maxEmbeddedBytes: 1, maxLocalProbes: 1 })

		expect(await resolved(manager, request("A"))).toMatchObject({ source: "local" })
		expect(await resolved(manager, request("B"))).toMatchObject({ source: "bundled" })
		expect(await resolved(manager, request("Bad\u0000Name"))).toMatchObject({ source: "bundled" })
		expect(host.localCalls).toEqual(["A"])
	})
})

describe("resolved fonts", () => {
	it("are interned: equal results share one object and id", async () => {
		const manager = new FontManager(new FakeHost(), new FakeAssets())
		const a = await resolved(manager, request("Calibri"))
		const b = await resolved(manager, request("calibri", { slot: "ascii" }))
		const c = await resolved(manager, request("Calibri", { bold: true }))

		expect(b).toBe(a)
		expect(c.id).not.toBe(a.id)
		expect(manager.resolve(request("Calibri"))).toBe(a)
	})

	it("format generic families without quotes and clamp sizes CSS cannot express", () => {
		const manager = new FontManager(new FakeHost(), new FakeAssets())
		const generic = manager.resolve(request("Nothing", { slot: "cs" }))

		expect(cssFont(generic, 12)).toBe("400 12px serif")
		expect(cssFont(generic, 1e-9)).toBe("400 0px serif")
		expect(cssFont(generic, Number.NaN)).toBe("400 0px serif")
		expect(cssFont(generic, -3)).toBe("400 0px serif")
		expect(cssFont(generic, Number.POSITIVE_INFINITY)).toBe("400 0px serif")
		expect(cssFont(generic, 1e30)).toBe("400 16384px serif")
		expect(cssFont(generic, 10.123456)).toBe("400 10.123px serif")
	})

	it("use the clone's original metrics for every family drawn with it", async () => {
		const manager = new FontManager(new FakeHost(), new FakeAssets())
		const arimo = BUNDLED_FACES.find(face => face.family === "arimo")

		manager.declare([declaration("Grotesk", { fontClass: "swiss" })])

		const helvetica = await resolved(manager, request("Helvetica"))
		const grotesk = await resolved(manager, request("Grotesk"))

		expect(helvetica).toMatchObject({ metricsBasis: "substitute", metrics: CLONE_METRICS.get("arimo")?.metrics })
		expect(grotesk.metrics).toBe(CLONE_METRICS.get("arimo")?.metrics)
		// Arimo's own win metrics were rebuilt and are not Arial's.
		expect(helvetica.metrics?.winAscent).not.toBe(arimo?.metrics.winAscent)
	})
})

describe("lifecycle", () => {
	it("removes a face that finishes loading after dispose, and starts none afterwards", async () => {
		const host = new FakeHost()
		let finish = (): void => {}
		const pending = new Promise<void>(resolve => {
			finish = resolve
		})
		const addBytes = host.addBytes.bind(host)

		host.addBytes = async (face, data) => {
			await pending

			return addBytes(face, data)
		}

		const manager = new FontManager(host, new FakeAssets())
		const loading = manager.prepare([request("Calibri")])

		await new Promise(resolve => setTimeout(resolve, 1))
		manager.dispose()
		finish()
		await loading
		expect(host.removed).toEqual([alias("carlito")])
		expect(manager.registrations()).toEqual([])

		const idle = new FakeHost()
		const early = new FontManager(idle, new FakeAssets())
		const started = early.prepare([request("Calibri")])

		early.dispose()
		await started
		expect(idle.faces).toEqual([])
	})

	it("unregisters every alias on dispose and refuses use afterwards", async () => {
		const host = new FakeHost(["Aptos"])
		const manager = new FontManager(host, new FakeAssets())

		await manager.prepare([request("Calibri"), request("Calibri", { bold: true }), request("Aptos")])
		expect(manager.registrations().map(registration => registration.source)).toEqual(expect.arrayContaining(["asset", "local"]))
		manager.dispose()
		expect(host.removed.sort()).toEqual([alias("carlito"), alias("l1")])
		expect(() => manager.resolve(request("Calibri"))).toThrow()
		await expect(manager.prepare([request("Calibri")])).rejects.toThrow()
	})

	it("keeps managers sharing one realm apart", async () => {
		const host = new FakeHost()
		const first = new FontManager(host, new FakeAssets())
		const second = new FontManager(host, new FakeAssets())
		const a = await resolved(first, request("Calibri"))
		const b = await resolved(second, request("Calibri"))

		expect(a.family).not.toBe(b.family)
		first.dispose()
		expect(host.removed).toEqual([a.family])
	})

	it("stays within the embedded budget however many families load at once", async () => {
		const font = realFont("caladea/Caladea-Regular.woff2")
		const host = new FakeHost()
		const limits = { maxEmbeddedFaceBytes: font.length * 2, maxEmbeddedBytes: Math.floor(font.length * 2.5), maxLocalProbes: 0 }
		const manager = new FontManager(host, new FakeAssets(), limits)
		const budgets: number[] = []
		let inFlight = 0
		let mostInFlight = 0

		for (let i = 0; i < 8; i++) {
			manager.embed(`F${i}`, false, false, async maxBytes => {
				budgets.push(maxBytes)
				mostInFlight = Math.max(mostInFlight, ++inFlight)
				await new Promise(resolve => setTimeout(resolve, 2))
				inFlight--

				return font
			})
		}

		await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(i => manager.prepare([request(`F${i}`)])))

		const loaded = [0, 1, 2, 3, 4, 5, 6, 7].filter(i => manager.resolve(request(`F${i}`)).source === "embedded")

		expect(loaded.length).toBe(2)
		expect(loaded.length * font.length).toBeLessThanOrEqual(limits.maxEmbeddedBytes)
		expect(mostInFlight).toBe(1)
		expect(budgets.every(budget => budget <= limits.maxEmbeddedFaceBytes)).toBe(true)
		expect(manager.failures().length).toBe(6)
	})

	it("stops loading and reports nothing once disposed mid-load", async () => {
		const host = new FakeHost()
		const manager = new FontManager(host, new FakeAssets())
		let release = (): void => {}
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		const font = realFont("caladea/Caladea-Regular.woff2")

		manager.embed("Lazy", false, false, async () => {
			await gate

			return font
		})

		const loading = manager.prepare([request("Lazy"), request("Calibri")])

		await new Promise(resolve => setTimeout(resolve, 1))
		manager.dispose()
		release()
		await loading
		expect(host.faces.filter(face => face.source === "bytes" && face.bytes === font.length)).toEqual([])
		expect(manager.failures()).toEqual([])
	})

	it("namespaces aliases per manager, randomly unless the caller names one", async () => {
		const host = new FakeHost()
		const named = new FontManager(host, new FakeAssets(), DEFAULT_FONT_LIMITS, "doc7")
		const a = new FontManager(host, new FakeAssets())
		const b = new FontManager(host, new FakeAssets())

		expect((await resolved(named, request("Calibri"))).family).toBe("doc7-carlito")
		expect((await resolved(a, request("Calibri"))).family).toMatch(/^fo[0-9a-f]{12}[0-9a-z]+-carlito$/)
		expect((await resolved(a, request("Calibri"))).family).not.toBe((await resolved(b, request("Calibri"))).family)
		expect(() => new FontManager(host, new FakeAssets(), DEFAULT_FONT_LIMITS, 'x", serif')).toThrow()
	})

	it("gives concurrently added faces of one family one alias", async () => {
		const host = new FakeHost()
		const manager = new FontManager(host, new FakeAssets())
		const font = realFont("caladea/Caladea-Regular.woff2")

		await Promise.all([manager.addEmbedded("Doc Font", font, false, false), manager.addEmbedded("Doc Font", font, true, false)])
		expect(host.faces.map(face => face.face.family)).toEqual([alias("e1"), alias("e1")])
		expect((await resolved(manager, request("Doc Font", { bold: true }))).weight).toBe(700)
	})
})

describe("embedded fonts", () => {
	it("register under an internal alias with the font's own metrics", async () => {
		const host = new FakeHost()
		const manager = new FontManager(host, new FakeAssets())
		const caladea = realFont("caladea/Caladea-Bold.woff2")

		expect(await manager.addEmbedded("Calibri", caladea, true, false)).toBe(true)

		const font = await resolved(manager, request("Calibri", { bold: true }))

		expect(font).toMatchObject({ family: alias("e1"), source: "embedded", weight: 700, metricsBasis: "font" })
		expect(font.metrics?.unitsPerEm).toBe(1000)
		// Only the bold face is embedded; regular text draws with it too.
		expect((await resolved(manager, request("Calibri"))).family).toEqual(alias("e1"))
		expect(manager.reembeddable("Calibri")).toBe(true)
		expect(manager.registrations()).toEqual([
			{ family: alias("e1"), weight: 700, italic: false, source: "embedded", declaredFamily: "Calibri" }
		])
	})

	it("refuse data that is no font, too large, or a style embedded twice", async () => {
		const font = realFont("caladea/Caladea-Regular.woff2")
		const limits = { maxEmbeddedFaceBytes: font.length * 2, maxEmbeddedBytes: Math.floor(font.length * 1.5), maxLocalProbes: 0 }
		const manager = new FontManager(new FakeHost(), new FakeAssets(), limits)

		await expect(manager.addEmbedded("A", new Uint8Array(1000), false, false)).rejects.toMatchObject({ code: "notSfnt" })
		await expect(manager.addEmbedded("B", new Uint8Array(font.length * 3), false, false)).rejects.toBeInstanceOf(FontError)
		expect(await manager.addEmbedded("X", font, false, false)).toBe(true)
		expect(await manager.addEmbedded("X", font, false, false)).toBe(false)
		// The total budget is what is left, not the per-face limit.
		await expect(manager.addEmbedded("X", font, true, false)).rejects.toMatchObject({ code: "tooLarge" })
		expect(manager.failures().map(failure => failure.family)).toEqual(["A", "B", "X", "X"])
	})

	it("load from a docx font table only when text needs them, obfuscated, stored or deflated", async () => {
		const key = "{1DF903E3-2F14-4575-8028-881FEBABF2AB}"
		const plain = realFont("caladea/Caladea-Regular.woff2")
		const obfuscated = obfuscateFont(plain, key)
		const fontTable = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<x:fonts xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<x:font x:name="Cambria"><x:panose1 x:val="02040503050406030204"/><x:charset x:val="00"/><x:family x:val="roman"/><x:pitch x:val="variable"/>
<x:embedRegular rel:id="rId1" x:fontKey="${key}"/><x:embedBold rel:id="rId2" x:fontKey="${key}" x:subsetted="1"/><x:embedItalic rel:id="rId3"/><x:embedBoldItalic rel:id="rId9"/></x:font>
<x:font x:name="Yu Gothic Light"><x:altName x:val="游ゴシック Light"/><x:charset x:val="80"/><x:family x:val="swiss"/></x:font>
<x:font x:name="Broken"><x:embedRegular rel:id="rId4" x:fontKey="${key}"/></x:font>
</x:fonts>`
		const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font1.odttf"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font2.odttf"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font3.ttf"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font4.odttf"/>
</Relationships>`
		const zip = buildZip([
			{
				name: "[Content_Types].xml",
				data: text('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
			},
			{ name: "word/fontTable.xml", data: text(fontTable) },
			{ name: "word/_rels/fontTable.xml.rels", data: text(rels) },
			{ name: "word/fonts/font1.odttf", data: obfuscated, method: 0 },
			{ name: "word/fonts/font2.odttf", data: obfuscated, method: 8 },
			{ name: "word/fonts/font3.ttf", data: plain, method: 8 },
			{ name: "word/fonts/font4.odttf", data: new Uint8Array(0), method: 0 }
		])
		const original = zip.slice()
		const pkg = await OpcPackage.open(bytesSource(zip))
		const declarations = readDocxFontTable(await pkg.xml("word/fontTable.xml"))

		expect(declarations.map(entry => entry.name)).toEqual(["Cambria", "Yu Gothic Light", "Broken"])
		expect(declarations[0]?.hints).toMatchObject({ fontClass: "roman", pitch: "variable", charset: 0 })
		expect(declarations[0]?.hints.panose?.[1]).toBe(4)
		expect(declarations[0]?.embeds.map(embed => [embed.style, embed.subsetted, embed.fontKey !== undefined])).toEqual([
			["regular", false, true],
			["bold", true, true],
			["italic", false, false],
			["boldItalic", false, false]
		])
		expect(declarations[1]).toMatchObject({ altNames: ["游ゴシック Light"], hints: { charset: 0x80, fontClass: "swiss" } })

		const host = new FakeHost()
		const manager = new FontManager(host, new FakeAssets())
		const embeddedFaces = (): [unknown, unknown, unknown][] =>
			host.faces.filter(face => /-e\d+$/.test(face.face.family)).map(face => [face.face.weight, face.face.italic, face.bytes])

		manager.declare(declarations)
		declareDocxEmbeddedFonts(manager, pkg, "word/fontTable.xml", declarations)
		expect(embeddedFaces()).toEqual([])

		await manager.prepare([request("Cambria")])
		expect(embeddedFaces()).toEqual([[400, false, plain.length]])

		await manager.prepare([
			request("Cambria", { bold: true }),
			request("Cambria", { italic: true }),
			request("Cambria", { bold: true, italic: true }),
			request("Broken")
		])
		expect(embeddedFaces().sort()).toEqual([
			[400, false, plain.length],
			[400, true, plain.length],
			[700, false, plain.length]
		])
		expect(
			manager
				.failures()
				.map(failure => `${failure.family}/${failure.bold}/${failure.italic}`)
				.sort()
		).toEqual(["Broken/false/false", "Cambria/true/true"])
		// Stored entries are views of the document; de-obfuscating must not have written into it.
		expect(Buffer.compare(zip, original)).toBe(0)
		expect(manager.resolve(request("Cambria", { bold: true, italic: true }))).toMatchObject({
			family: alias("e1"),
			source: "embedded",
			generic: "serif"
		})
		expect(manager.resolve(request("Broken"))).toMatchObject({ family: alias("tinos") })
		expect(await resolved(manager, request("游ゴシック Light", { slot: "eastAsia" }))).toMatchObject({ source: "generic" })

		const capped = new FontManager(new FakeHost(), new FakeAssets(), { ...DEFAULT_FONT_LIMITS, maxEmbeddedFaceBytes: 1000 })

		declareDocxEmbeddedFonts(capped, pkg, "word/fontTable.xml", declarations.slice(0, 1))
		expect(await resolved(capped, request("Cambria"))).toMatchObject({ family: alias("caladea"), source: "bundled" })
		expect(capped.failures().length).toBe(4)
	})

	it("ignore a font table in an unknown namespace", () => {
		expect(readDocxFontTable(parseXml(text('<fonts xmlns="urn:other"><font name="X"/></fonts>')))).toEqual([])
	})
})

describe("font slots", () => {
	const context = (overrides: Partial<SlotContext> = {}): SlotContext => ({ ...DEFAULT_SLOT_CONTEXT, ...overrides })
	const hinted = context({ hint: "eastAsia" })

	it("follows Word's Unicode block table", () => {
		const cases: [number, SlotContext, FontSlot][] = [
			[0x41, hinted, "ascii"],
			[0xe9, context(), "hAnsi"],
			[0xa7, context(), "hAnsi"],
			[0xa7, hinted, "eastAsia"],
			[0xe9, hinted, "hAnsi"],
			[0xe9, context({ hint: "eastAsia", chineseLanguage: true }), "eastAsia"],
			[0x101, hinted, "hAnsi"],
			[0x101, context({ hint: "eastAsia", chineseFontCharset: true }), "eastAsia"],
			[0x1ea1, context({ hint: "eastAsia", chineseFontCharset: true }), "hAnsi"],
			[0x1ea1, context({ hint: "eastAsia", chineseLanguage: true }), "eastAsia"],
			[0x2c6, hinted, "eastAsia"],
			[0x301, hinted, "eastAsia"],
			[0x3b1, hinted, "eastAsia"],
			[0x3d5, hinted, "hAnsi"],
			[0x201c, context(), "hAnsi"],
			[0x201c, hinted, "eastAsia"],
			[0x201c, context({ hint: "cs" }), "hAnsi"],
			[0x2e80, context(), "hAnsi"],
			[0x2e80, hinted, "eastAsia"],
			[0x6f22, context(), "eastAsia"],
			[0xfe50, context(), "eastAsia"],
			[0x1f600, context(), "eastAsia"],
			[0x20000, context(), "eastAsia"],
			[0x5d0, context(), "ascii"],
			[0x627, context(), "ascii"],
			[0xfb1d, context(), "ascii"],
			[0xfefc, context(), "ascii"],
			[0x915, context(), "hAnsi"],
			[0xe01, context(), "hAnsi"],
			[0x41, context({ complexScript: true }), "cs"]
		]

		for (const [codePoint, slotContext, slot] of cases) expect(fontSlot(codePoint, slotContext), codePoint.toString(16)).toBe(slot)
	})

	it("reads the language and charset conditions and the Times New Roman rule", () => {
		expect([isChineseLanguage("zh-CN"), isChineseLanguage("ZH"), isChineseLanguage("ja-JP"), isChineseLanguage(undefined)]).toEqual([
			true,
			true,
			false,
			false
		])
		expect([isChineseCharset(134), isChineseCharset(136), isChineseCharset(128)]).toEqual([true, true, false])
		expect(eastAsiaUsesAscii("Calibri", "Calibri", "Times New Roman")).toBe(true)
		expect(eastAsiaUsesAscii("calibri", "CALIBRI", "times new roman")).toBe(true)
		expect(eastAsiaUsesAscii("Calibri", "Arial", "Times New Roman")).toBe(false)
		expect(eastAsiaUsesAscii("Calibri", "Calibri", "MS Mincho")).toBe(false)
	})

	it("splits text into slot runs, keeping joined sequences together", () => {
		const runs: [number, number, FontSlot][] = []

		forEachSlotRun("Hi 世界! \u0628\u064e \u00e9 \u{1F600}\uFE0F1\u20E3", context(), (start, end, slot) =>
			runs.push([start, end, slot])
		)

		// Arabic letters take the ascii font unless the run is marked complex script; the variation selector
		// stays with the emoji and the keycap mark with its digit.
		expect(runs).toEqual([
			[0, 3, "ascii"],
			[3, 5, "eastAsia"],
			[5, 10, "ascii"],
			[10, 11, "hAnsi"],
			[11, 12, "ascii"],
			[12, 15, "eastAsia"],
			[15, 17, "ascii"]
		])

		const all: FontSlot[] = []

		forEachSlotRun("abc", context({ complexScript: true }), (_start, _end, slot) => all.push(slot))
		expect(all).toEqual(["cs"])
	})
})

describe("FontFace host", () => {
	class FakeFontFace {
		static installed = new Set(['local("Aptos")'])
		readonly family: string
		readonly source: string | ArrayBuffer
		readonly descriptors: { weight: string; style: string }

		constructor(family: string, source: string | ArrayBuffer, descriptors: { weight: string; style: string }) {
			this.family = family
			this.source = source
			this.descriptors = descriptors
		}

		load(): Promise<this> {
			if (typeof this.source === "string" && !FakeFontFace.installed.has(this.source))
				return Promise.reject(new Error("NetworkError"))
			if (this.source instanceof ArrayBuffer && this.source.byteLength === 0) return Promise.reject(new Error("bad font"))

			return Promise.resolve(this)
		}
	}

	it("registers bytes and installed fonts and removes them by alias", async () => {
		const set = new Set<FakeFontFace>()
		const scope: FontFaceScope = {
			FontFace: FakeFontFace,
			fonts: { add: (face: FakeFontFace) => set.add(face), delete: (face: FakeFontFace) => set.delete(face) }
		}
		const host = fontFaceHost(scope)
		const whole = new Uint8Array(8)
		const view = new Uint8Array(16).subarray(4, 12)

		expect(await host.addBytes({ family: "fo1-arimo", weight: [400, 700], italic: true }, whole)).toBe(true)
		expect(await host.addBytes({ family: "fo1-arimo", weight: 400, italic: false }, view)).toBe(true)
		expect(await host.addBytes({ family: "fo1-bad", weight: 400, italic: false }, new Uint8Array(0))).toBe(false)
		expect(await host.addLocal({ family: "fo1-l1", weight: 400, italic: false }, "Aptos")).toBe(true)
		expect(await host.addLocal({ family: "fo1-l2", weight: 400, italic: false }, "Missing")).toBe(false)

		const faces = [...set]

		expect(faces.map(face => [face.family, face.descriptors.weight, face.descriptors.style])).toEqual([
			["fo1-arimo", "400 700", "italic"],
			["fo1-arimo", "400", "normal"],
			["fo1-l1", "400", "normal"]
		])
		expect(faces[0]?.source).toBe(whole.buffer)
		const sliced = faces[1]?.source

		expect(sliced instanceof ArrayBuffer ? sliced.byteLength : -1).toBe(8)

		host.remove("fo1-arimo")
		expect([...set].map(face => face.family)).toEqual(["fo1-l1"])
	})

	it("quotes installed-font names so a document cannot break out of the string", () => {
		expect(localSource('Evil") , url(x'.concat("\\\n"))).toBe('local("Evil\\") , url(x\\\\")')
	})
})
