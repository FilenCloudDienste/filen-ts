import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { strFromU8, unzipSync } from "fflate"
import { afterAll, describe, expect, it } from "vitest"
import {
	BookmarkCursor,
	fadeGain,
	formatUniversalTime,
	mediaTimingLosses,
	parseUniversalTime,
	playWindow,
	type MediaTiming
} from "../core/anim/media"
import { compile, instantiate } from "../core/anim/timegraph"
import { EFFECT_PRESETS } from "../core/anim/presets/effects/index"
import { convertPresentation } from "../core/convert/presentation/index"
import { memorySink } from "../core/opc/index"
import { addEffectsOp, slideEffects } from "../core/presentation/edit/commands/timing"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideNode } from "../core/presentation/model"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { viewCapability } from "../dom/presentation/engine/view"
import { layersOf } from "./animAuthoringFixtures"
import { BUDGETS } from "./animFixtures"
import { modelVsFile } from "./modelVsFile"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { loadAllowlist, newSdkErrors, OpenXmlSdk, openXmlSdkMissing, sdkErrorCounts } from "./oracles/openXmlSdk"
import { body, buildPptx, para, sp } from "./pptxFixtures"
import { image } from "./presentationObjectsFixtures"
import { openDeck, slideNode } from "./pptxWriteFixtures"

// A medium's trim, fade and bookmarks (MS-PPTX p14:media) read, edited, saved and played: values in any
// ST_UniversalTimeOffset unit read as milliseconds; an edit rewrites only the group it changed (the rest of p14:media
// keeps its bytes); undo after a save writes the source back byte for byte; a bookmark trigger round-trips as
// p14:bmkTgt and starts its effect when the medium reaches it; ODF has none of them, so a conversion reports each.
//
// Oracles (opt-in): FILEN_OFFICE_OOXML_VALIDATOR (Open XML SDK, no new error); FILEN_OFFICE_ODFVALIDATOR (odfvalidator
// -1.3 on the converted ODP); FILEN_OFFICE_JING with FILEN_OFFICE_ODF_RNG (jing -i on its content.xml).

const SDK_MISSING = openXmlSdkMissing()
const ODF_VALIDATOR = process.env["FILEN_OFFICE_ODFVALIDATOR"] ?? ""
const JING = process.env["FILEN_OFFICE_JING"] ?? ""
const ODF_RNG = process.env["FILEN_OFFICE_ODF_RNG"] ?? ""
const scratch = mkdtempSync(join(tmpdir(), "filen-media-timing-"))

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true })
})

function mp4(size: number): Uint8Array {
	const bytes = new Uint8Array(size)

	bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31], 0)

	return bytes
}

const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
const VIDEO = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/video"
const MEDIA = "http://schemas.microsoft.com/office/2007/relationships/media"

// A video picture whose p14:media holds `inner` (trim, fade, bookmarks as the test writes them).
function videoPic(id: number, inner: string, p14 = true): string {
	const media = p14
		? `<p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="${P14}" r:embed="rId11"${inner === "" ? "/>" : `>${inner}</p14:media>`}</p:ext></p:extLst>`
		: ""

	return (
		`<p:pic><p:nvPicPr><p:cNvPr id="${String(id)}" name="Video ${String(id)}"><a:hlinkClick r:id="" action="ppaction://media"/></p:cNvPr><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr><a:videoFile r:link="rId10"/>` +
		`${media}</p:nvPr></p:nvPicPr>` +
		'<p:blipFill><a:blip r:embed="rId12"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
		'<p:spPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="4000000" cy="3000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
	)
}

const SOURCE_TIMING =
	'<p14:trim st="1.5s" end="250"/><p14:fade in="0.5s" out="1000ms"/>' +
	'<p14:bmkLst><p14:bmk name="Chorus" time="4000"/><p14:bmk name="Intro" time="0.75s"/></p14:bmkLst>'

function videoDeck(inner: string = SOURCE_TIMING, p14 = true): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "Title 1", 'type="title"', "", body(para("Media"))) +
					videoPic(4, inner, p14) +
					sp(
						5,
						"Box 5",
						undefined,
						'<a:xfrm><a:off x="6000000" y="1000000"/><a:ext cx="1000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
					),
				rels: [
					["rId10", VIDEO, "../media/media1.mp4"],
					["rId11", MEDIA, "../media/media1.mp4"],
					["rId12", "image", "../media/image1.png"]
				]
			}
		],
		parts: {
			"ppt/media/media1.mp4": { data: mp4(4096), type: "video/mp4" },
			"ppt/media/image1.png": { data: image().bytes, type: "image/png" }
		}
	})
}

function slidePart(bytes: Uint8Array): string {
	return strFromU8(unzipSync(bytes)["ppt/slides/slide1.xml"] ?? new Uint8Array())
}

function p14MediaOf(xml: string): string {
	return /<p14:media\b[^>]*?(?:\/>|>[\s\S]*?<\/p14:media>)/u.exec(xml)?.[0] ?? ""
}

type Drive = Awaited<ReturnType<typeof driveSession>>

function shapeIn(node: SlideNode, id: number): ShapeNode {
	const shape = node.shapes.find(candidate => candidate.id === id)

	if (shape === undefined) throw new Error(`no shape ${String(id)}`)

	return shape
}

async function slideOf(d: Drive): Promise<SlideNode> {
	const ref = d.session.deck.slides[0]
	const parts = pptxParts(d.session.deck)

	if (ref === undefined || parts === undefined) throw new Error("no slide")

	return parts.slide(ref)
}

async function timingOf(d: Drive): Promise<MediaTiming | undefined> {
	return shapeIn(await slideOf(d), 4).media?.timing
}

async function run(d: Drive, op: DeckOp): Promise<number> {
	const result = await d.command(op)

	if (!result.ok) throw new Error(result.refusal)

	return result.revision
}

async function saved(d: Drive): Promise<Uint8Array> {
	const { result, bytes } = await d.save()

	if (result.kind !== "written" || bytes === undefined) throw new Error(JSON.stringify(result))

	return bytes
}

function target(d: Drive): { slide: never; id: number } {
	return { slide: d.session.deck.slides[0] as never, id: 4 }
}

describe("ST_UniversalTimeOffset", () => {
	it("reads every unit as milliseconds and writes milliseconds without a unit", () => {
		expect(["18374.0515", "1.5s", "2min", "1h", "250ms", "500µs", "2000000ns"].map(text => parseUniversalTime(text))).toEqual([
			18374.0515, 1500, 120_000, 3_600_000, 250, 0.5, 2
		])
		expect(["", "-1", "1e3", "abc", "25h"].map(text => parseUniversalTime(text))).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined
		])
		expect([18374.0515, 1500, 0.123456].map(formatUniversalTime)).toEqual(["18374.0515", "1500", "0.1235"])
	})
})

describe("media timing read from p14:media", () => {
	it("gives the shape and its layer the trim, fade and bookmarks in time order", async () => {
		const d = await driveSession(videoDeck(), "pptx")
		const expected: MediaTiming = {
			trim: { startMs: 1500, endMs: 250 },
			fade: { inMs: 500, outMs: 1000 },
			bookmarks: [
				{ name: "Intro", timeMs: 750 },
				{ name: "Chorus", timeMs: 4000 }
			]
		}

		expect(await timingOf(d)).toEqual(expected)

		const [render] = await viewCapability.render(d.context, [d.session.deck.slides[0] as never])

		expect(render?.layers.find(layer => layer.media !== undefined)?.media?.timing).toEqual(expected)
	})
})

describe("media timing edits saved in pptx", () => {
	it("rewrites only the group an edit changed and reads back what the session holds", { timeout: 60_000 }, async () => {
		const d = await driveSession(videoDeck(), "pptx")

		await run(d, { family: "mediaTiming", kind: "setTrim", target: target(d), startMs: 2000, endMs: 500 })

		const bytes = await saved(d)
		const media = p14MediaOf(slidePart(bytes))

		// The trim rewritten; the fade and the bookmarks keep their source spelling.
		expect(media).toContain('<p14:trim st="2000" end="500"/><p14:fade in="0.5s" out="1000ms"/><p14:bmkLst>')
		expect(await modelVsFile(d, bytes, "pptx")).toBe("")

		const reopened = await openDeck(bytes)

		expect(shapeIn(slideNode(reopened, 0), 4).media?.timing).toEqual(await timingOf(d))
	})

	it("adds and removes bookmarks, sets a fade and clears a trim, in schema order", { timeout: 60_000 }, async () => {
		const d = await driveSession(videoDeck(""), "pptx")
		const at = target(d)

		await run(d, { family: "mediaTiming", kind: "addBookmark", target: at, name: 'B <&">', timeMs: 3000 })
		await run(d, { family: "mediaTiming", kind: "addBookmark", target: at, name: "A", timeMs: 1000 })
		await run(d, { family: "mediaTiming", kind: "setFade", target: at, inMs: 250, outMs: 0 })
		await run(d, { family: "mediaTiming", kind: "setTrim", target: at, startMs: 100, endMs: 0 })
		await run(d, { family: "mediaTiming", kind: "setTrim", target: at, startMs: 0, endMs: 0 })

		const bytes = await saved(d)

		expect(p14MediaOf(slidePart(bytes))).toBe(
			`<p14:media xmlns:p14="${P14}" r:embed="rId11"><p14:fade in="250" out="0"/><p14:bmkLst>` +
				'<p14:bmk name="A" time="1000"/><p14:bmk name="B &lt;&amp;&quot;>" time="3000"/></p14:bmkLst></p14:media>'
		)
		expect(shapeIn(slideNode(await openDeck(bytes), 0), 4).media?.timing).toEqual({
			fade: { inMs: 250, outMs: 0 },
			bookmarks: [
				{ name: "A", timeMs: 1000 },
				{ name: 'B <&">', timeMs: 3000 }
			]
		})

		await run(d, { family: "mediaTiming", kind: "removeBookmark", target: at, name: "A" })
		await run(d, { family: "mediaTiming", kind: "removeBookmark", target: at, name: 'B <&">' })
		await run(d, { family: "mediaTiming", kind: "setFade", target: at, inMs: 0, outMs: 0 })

		const cleared = await saved(d)

		expect(p14MediaOf(slidePart(cleared))).toBe(`<p14:media xmlns:p14="${P14}" r:embed="rId11"></p14:media>`)
		expect(shapeIn(slideNode(await openDeck(cleared), 0), 4).media?.timing).toBeUndefined()
	})

	it("undoes an edit saved before with the source bytes, and redoes it", { timeout: 60_000 }, async () => {
		const source = videoDeck()
		const d = await driveSession(source, "pptx")

		await run(d, { family: "mediaTiming", kind: "setFade", target: target(d), inMs: 2000, outMs: 2000 })

		const edited = await saved(d)

		expect(p14MediaOf(slidePart(edited))).toContain('<p14:fade in="2000" out="2000"/>')

		await d.undo()

		const undone = await saved(d)

		expect(slidePart(undone)).toBe(slidePart(source))

		await d.redo()

		const redone = await saved(d)

		expect(slidePart(redone)).toBe(slidePart(edited))
		expect(await modelVsFile(d, redone, "pptx")).toBe("")
	})

	it("keeps an edit made while a save is under way for the next save", { timeout: 60_000 }, async () => {
		const d = await driveSession(videoDeck(), "pptx")

		await run(d, { family: "mediaTiming", kind: "setTrim", target: target(d), startMs: 100, endMs: 100 })

		const release = d.drive.hold()
		const begun = d.begin()

		await run(d, { family: "mediaTiming", kind: "addBookmark", target: target(d), name: "Late", timeMs: 2500 })
		release()

		const first = await begun

		await first.commit()

		expect(p14MediaOf(slidePart(first.bytes ?? new Uint8Array()))).not.toContain("Late")

		const second = await saved(d)

		expect(p14MediaOf(slidePart(second))).toContain('<p14:trim st="100" end="100"/>')
		expect(p14MediaOf(slidePart(second))).toContain('<p14:bmk name="Late" time="2500"/>')
		expect(await modelVsFile(d, second, "pptx")).toBe("")
	})

	it("refuses what a file cannot hold", async () => {
		const d = await driveSession(videoDeck(), "pptx")
		const at = target(d)
		const refusal = async (op: DeckOp): Promise<string | undefined> => {
			const result = await d.command(op)

			return result.ok ? undefined : result.refusal
		}

		expect(await refusal({ family: "mediaTiming", kind: "setTrim", target: at, startMs: -1, endMs: 0 })).toBe("malformed")
		expect(await refusal({ family: "mediaTiming", kind: "setFade", target: at, inMs: Number.NaN, outMs: 0 })).toBe("malformed")
		expect(await refusal({ family: "mediaTiming", kind: "addBookmark", target: at, name: "Chorus", timeMs: 1 })).toBe("unsupported")
		expect(await refusal({ family: "mediaTiming", kind: "addBookmark", target: at, name: "Other", timeMs: 4000 })).toBe("unsupported")
		expect(await refusal({ family: "mediaTiming", kind: "addBookmark", target: at, name: " ", timeMs: 1 })).toBe("malformed")
		expect(await refusal({ family: "mediaTiming", kind: "addBookmark", target: at, name: "a\u0001", timeMs: 1 })).toBe("malformed")
		expect(await refusal({ family: "mediaTiming", kind: "removeBookmark", target: at, name: "None" })).toBe("notFound")
		expect(await refusal({ family: "mediaTiming", kind: "setTrim", target: { ...at, id: 5 }, startMs: 0, endMs: 1 })).toBe(
			"unsupported"
		)

		// A PowerPoint 2007 medium (a:videoFile alone) has nowhere to hold them.
		const old = await driveSession(videoDeck("", false), "pptx")

		expect((await old.command({ family: "mediaTiming", kind: "setTrim", target: target(old), startMs: 1, endMs: 0 })).ok).toBe(false)
	})

	it("adds no Open XML SDK error", { timeout: 300_000 }, async ({ skip }) => {
		if (SDK_MISSING !== undefined) skip()

		const d = await driveSession(videoDeck(), "pptx")

		await run(d, { family: "mediaTiming", kind: "setTrim", target: target(d), startMs: 2000, endMs: 500 })
		await run(d, { family: "mediaTiming", kind: "addBookmark", target: target(d), name: "Outro", timeMs: 6000 })
		await bookmarkTrigger(d, "Outro")

		const sourcePath = join(scratch, "timing-source.pptx")
		const savedPath = join(scratch, "timing.pptx")

		writeFileSync(sourcePath, videoDeck())
		writeFileSync(savedPath, await saved(d))

		const sdk = new OpenXmlSdk()

		try {
			const before = sdkErrorCounts(await sdk.validate(sourcePath))
			const after = sdkErrorCounts(await sdk.validate(savedPath))

			expect(newSdkErrors(before, after, loadAllowlist())).toEqual([])
		} finally {
			await sdk.close()
		}
	})
})

// An Appear effect on the box (shape 5), started by the video's bookmark `name`.
async function bookmarkTrigger(d: Drive, name: string): Promise<void> {
	const slide = await slideOf(d)
	const appear = EFFECT_PRESETS.find(preset => preset.presetClass === "entr" && preset.id === 1)

	if (appear === undefined) throw new Error("no Appear preset")

	const add = addEffectsOp(slide.ref, [], [{ id: 5 }], { preset: appear, aspect: 4 / 3 })

	if (add === undefined) throw new Error("no effect")

	await run(d, add)

	const row = slideEffects((await slideOf(d)).timing)

	if (row.kind !== "effects" || row.rows[0] === undefined) throw new Error("no row")

	await run(d, {
		family: "timing",
		kind: "setEffectTiming",
		slide: slide.ref,
		node: row.rows[0].id,
		timing: { trigger: { kind: "bookmark", shape: 4, bookmark: name } }
	})
}

describe("bookmark triggers", () => {
	it("round-trip as p14:bmkTgt and start their effect when the medium reaches the bookmark", { timeout: 60_000 }, async () => {
		const d = await driveSession(videoDeck(), "pptx")

		await bookmarkTrigger(d, "Chorus")

		const rows = slideEffects((await slideOf(d)).timing)

		expect(rows.kind === "effects" ? rows.rows.map(row => [row.trigger, row.bookmark]) : []).toEqual([[4, "Chorus"]])

		const bytes = await saved(d)
		const xml = slidePart(bytes)

		expect(xml).toMatch(
			/<p:cond evt="onMediaBookmark" delay="0"><p:tgtEl><p14:bmkTgt xmlns:p14="[^"]+" spid="4" bmkName="Chorus"\/><\/p:tgtEl><\/p:cond>/u
		)

		const node = slideNode(await openDeck(bytes), 0)
		const reread = slideEffects(node.timing)

		expect(reread.kind === "effects" ? reread.rows.map(row => [row.trigger, row.bookmark]) : []).toEqual([[4, "Chorus"]])

		// Played: hidden until the bookmark, shown from the event on.
		const layers = layersOf(node)
		const box = Array.from(layers.shapes).indexOf(5)
		const t = instantiate(compile(node, layers, BUDGETS))

		t.fire({ kind: "slideBegin" }, 0)
		t.fire({ kind: "mediaBookmark", shape: 4, bookmark: "Intro" }, 100)
		expect(t.sample(200).find(state => state.layer === box)?.visible).toBe(false)
		t.fire({ kind: "mediaBookmark", shape: 4, bookmark: "Chorus" }, 300)
		expect(t.sample(300).find(state => state.layer === box)?.visible).toBe(true)
	})

	it("refuses a trigger on a bookmark the medium lacks and the removal of one a trigger names", async () => {
		const d = await driveSession(videoDeck(), "pptx")

		await expect(bookmarkTrigger(d, "Missing")).rejects.toThrow("notFound")

		const d2 = await driveSession(videoDeck(), "pptx")

		await bookmarkTrigger(d2, "Intro")

		const result = await d2.command({ family: "mediaTiming", kind: "removeBookmark", target: target(d2), name: "Intro" })

		expect(result).toEqual({ ok: false, refusal: "unsupported" })
	})
})

describe("media timing and ODF", () => {
	it("is refused in an OpenDocument deck", async () => {
		const d = await driveSession(
			odpBytes({
				body: '<draw:page draw:name="One" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>Media</text:p></draw:text-box></draw:frame></draw:page>'
			}),
			"odp"
		)
		const at = { slide: d.session.deck.slides[0] as never, id: 1 }

		for (const op of [
			{ family: "mediaTiming", kind: "setTrim", target: at, startMs: 1, endMs: 0 },
			{ family: "mediaTiming", kind: "setFade", target: at, inMs: 1, outMs: 0 },
			{ family: "mediaTiming", kind: "addBookmark", target: at, name: "a", timeMs: 1 },
			{ family: "mediaTiming", kind: "removeBookmark", target: at, name: "a" }
		] as const)
			expect(await d.command(op)).toEqual({ ok: false, refusal: "unsupported" })
	})

	it(
		"converts to ODP that validates, reporting every trim, fade and bookmark as lost and the triggered effect as started on click",
		{ timeout: 300_000 },
		async () => {
			const d = await driveSession(videoDeck(), "pptx")

			await bookmarkTrigger(d, "Chorus")

			const opened = await openDeck(await saved(d))
			const sink = memorySink()
			const out = await convertPresentation(opened.deck, { format: "pptx", parts: opened.parts, source: opened.source }, "odp", sink)

			if ("kind" in out) throw new Error(`${out.reason} ${out.detail ?? ""}`)

			const losses = out.losses

			// The trim, the fade and two bookmarks; the triggered effect starts on a click of the clip instead.
			expect(losses.find(loss => loss.kind === "mediaTiming")?.count).toBe(4)
			expect(losses.find(loss => loss.kind === "bookmarkTrigger")?.count).toBe(1)

			const odp = sink.bytes().slice()
			const content = strFromU8(unzipSync(odp)["content.xml"] ?? new Uint8Array())

			expect(content).not.toContain('smil:begin="indefinite"')
			expect(content).toMatch(/smil:begin="[^"]+\.click"/u)

			const path = join(scratch, "timing.odp")

			writeFileSync(path, odp)

			if (ODF_VALIDATOR !== "") {
				const result = spawnSync("java", ["-jar", ODF_VALIDATOR, "-1.3", "-v", path], { encoding: "utf8", maxBuffer: 1 << 26 })

				expect(result.error).toBeUndefined()
				expect(`${result.stdout}${result.stderr}`).toMatch(/timing\.odp:\s+Info: no errors, no warnings/u)
				expect(`${result.stdout}\n${result.stderr}`.split("\n").filter(line => /(?:Error|Fatal):/u.test(line))).toEqual([])
			}

			if (JING !== "" && ODF_RNG !== "") {
				const dir = mkdtempSync(join(scratch, "jing-"))

				writeFileSync(join(dir, "content.xml"), unzipSync(odp)["content.xml"] ?? new Uint8Array())

				const result = spawnSync("java", ["-jar", JING, "-i", ODF_RNG, join(dir, "content.xml")], { encoding: "utf8" })

				expect(result.status).toBe(0)
				expect(result.stdout + result.stderr).toBe("")
			}
		}
	)

	it("lists the losses of a medium's timing", () => {
		expect(
			mediaTimingLosses({ trim: { startMs: 1, endMs: 0 }, fade: { inMs: 0, outMs: 0 }, bookmarks: [{ name: "a", timeMs: 1 }] })
		).toEqual(["media trim", "media bookmark"])
	})
})

describe("the playback schedule", () => {
	it("plays the window the trim leaves and fades in and out over it", () => {
		const timing: MediaTiming = { trim: { startMs: 1000, endMs: 2000 }, fade: { inMs: 500, outMs: 1000 } }
		const window = playWindow(timing, 10_000)

		expect(window).toEqual({ startMs: 1000, endMs: 8000 })
		expect(playWindow(timing, Number.NaN)).toEqual({ startMs: 1000, endMs: Number.POSITIVE_INFINITY })
		expect([1000, 1250, 1500, 5000, 7500, 8000].map(ms => fadeGain(timing, window, ms))).toEqual([0, 0.5, 1, 1, 0.5, 0])
	})

	it("fires each bookmark passed once, in order, and none passed before a seek", () => {
		const cursor = new BookmarkCursor([
			{ name: "a", timeMs: 100 },
			{ name: "b", timeMs: 200 },
			{ name: "c", timeMs: 300 }
		])
		const fired: string[] = []

		cursor.seek(0)
		cursor.advance(150, name => fired.push(name))
		cursor.advance(150, name => fired.push(name))
		cursor.advance(320, name => fired.push(name))
		expect(fired).toEqual(["a", "b", "c"])

		cursor.seek(250)
		cursor.advance(400, name => fired.push(name))
		expect(fired).toEqual(["a", "b", "c", "c"])
	})
})
