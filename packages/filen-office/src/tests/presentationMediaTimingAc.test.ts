import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { strFromU8, unzipSync } from "fflate"
import { afterAll, describe, expect, it } from "vitest"
import { EFFECT_PRESETS } from "../core/anim/presets/effects/index"
import { convertPresentation } from "../core/convert/presentation/index"
import { memorySink } from "../core/opc/index"
import { addEffectsOp, slideEffects } from "../core/presentation/edit/commands/timing"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { SlideNode } from "../core/presentation/model"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { modelVsFile } from "./modelVsFile"
import { driveSession } from "./odpWriteDrive"
import { loadAllowlist, newSdkErrors, OpenXmlSdk, openXmlSdkMissing, sdkErrorCounts } from "./oracles/openXmlSdk"
import { body, buildPptx, para, sp } from "./pptxFixtures"
import { image } from "./presentationObjectsFixtures"
import { openDeck, slideNode } from "./pptxWriteFixtures"

// A slide's timing in mc:AlternateContent (MS-PPTX §2.2.2: a timing that uses p14, here a media bookmark trigger, is a
// p14 Choice with a Fallback PowerPoint 2007 reads): kept whole while unchanged, written as one AlternateContent
// (Choice rewritten, Fallback regenerated with each bookmark trigger started on a click of its clip, as PowerPoint
// writes it) when it changed, and never a second p:timing. Bookmarks the reader could not take stay in the file when the
// list is edited; an undo restores whatever the file held; an ODP copy starts a bookmark-triggered effect on a click.
//
// Oracle (opt-in): FILEN_OFFICE_OOXML_VALIDATOR (Open XML SDK, no new error).

const SDK_MISSING = openXmlSdkMissing()
const scratch = mkdtempSync(join(tmpdir(), "filen-media-timing-ac-"))

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true })
})

const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
const VIDEO = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/video"
const MEDIA = "http://schemas.microsoft.com/office/2007/relationships/media"

function mp4(): Uint8Array {
	const bytes = new Uint8Array(4096)

	bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31], 0)

	return bytes
}

function videoPic(inner: string): string {
	return (
		'<p:pic><p:nvPicPr><p:cNvPr id="4" name="Video 4"><a:hlinkClick r:id="" action="ppaction://media"/></p:cNvPr><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr><a:videoFile r:link="rId10"/>' +
		`<p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="${P14}" r:embed="rId11">${inner}</p14:media></p:ext></p:extLst></p:nvPr></p:nvPicPr>` +
		'<p:blipFill><a:blip r:embed="rId12"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
		'<p:spPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="4000000" cy="3000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
	)
}

const BOX =
	'<a:xfrm><a:off x="6000000" y="1000000"/><a:ext cx="1000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
const BOOKMARKS = '<p14:bmkLst><p14:bmk name="Chorus" time="4000"/><p14:bmk name="Intro" time="750"/></p14:bmkLst>'
const BOOKMARK_CONDITION = '<p:cond evt="onMediaBookmark" delay="0"><p:tgtEl><p14:bmkTgt spid="4" bmkName="Chorus"/></p:tgtEl></p:cond>'
const CLICK_CONDITION = '<p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="4"/></p:tgtEl></p:cond>'

// PowerPoint's timing for an Appear on the box started by `condition`.
function timing(condition: string): string {
	return (
		'<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>' +
		`<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" restart="whenNotActive" fill="hold" evtFilter="cancelBubble" nodeType="interactiveSeq"><p:stCondLst>${condition}</p:stCondLst><p:endSync evt="end" delay="0"><p:rtn val="all"/></p:endSync><p:childTnLst>` +
		'<p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>' +
		'<p:par><p:cTn id="5" presetID="1" presetClass="entr" presetSubtype="0" fill="hold" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:set><p:cBhvr><p:cTn id="6" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="5"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set></p:childTnLst></p:cTn></p:par>' +
		`</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn><p:nextCondLst>${condition}</p:nextCondLst></p:seq>` +
		"</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>"
	)
}

// As PowerPoint writes it: the bookmark trigger in the p14 Choice, a click on the clip in the Fallback.
const AC_TIMING = `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:p14="${P14}" Requires="p14">${timing(BOOKMARK_CONDITION)}</mc:Choice><mc:Fallback>${timing(CLICK_CONDITION)}</mc:Fallback></mc:AlternateContent>`
const AC_CLICK = `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:p14="${P14}" Requires="p14">${timing(CLICK_CONDITION)}</mc:Choice><mc:Fallback>${timing(CLICK_CONDITION)}</mc:Fallback></mc:AlternateContent>`

function deck(after?: string, inner = BOOKMARKS): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes: sp(2, "Title 1", 'type="title"', "", body(para("Media"))) + videoPic(inner) + sp(5, "Box 5", undefined, BOX),
				rels: [
					["rId10", VIDEO, "../media/media1.mp4"],
					["rId11", MEDIA, "../media/media1.mp4"],
					["rId12", "image", "../media/image1.png"]
				],
				...(after === undefined ? {} : { after })
			}
		],
		parts: {
			"ppt/media/media1.mp4": { data: mp4(), type: "video/mp4" },
			"ppt/media/image1.png": { data: image().bytes, type: "image/png" }
		}
	})
}

type Drive = Awaited<ReturnType<typeof driveSession>>

function slidePart(bytes: Uint8Array): string {
	return strFromU8(unzipSync(bytes)["ppt/slides/slide1.xml"] ?? new Uint8Array())
}

function count(xml: string, text: string): number {
	return xml.split(text).length - 1
}

async function saved(d: Drive): Promise<Uint8Array> {
	const { result, bytes } = await d.save()

	if (result.kind !== "written" || bytes === undefined) throw new Error(JSON.stringify(result))

	return bytes
}

async function run(d: Drive, op: DeckOp): Promise<void> {
	const result = await d.command(op)

	if (!result.ok) throw new Error(result.refusal)
}

function target(d: Drive): { slide: never; id: number } {
	return { slide: d.session.deck.slides[0] as never, id: 4 }
}

async function slideOf(d: Drive): Promise<SlideNode> {
	const ref = d.session.deck.slides[0]
	const parts = pptxParts(d.session.deck)

	if (ref === undefined || parts === undefined) throw new Error("no slide")

	return parts.slide(ref)
}

// An Appear on the box started by the clip's bookmark `name`.
async function bookmarkTrigger(d: Drive, name: string): Promise<void> {
	const slide = await slideOf(d)
	const appear = EFFECT_PRESETS.find(preset => preset.presetClass === "entr" && preset.id === 1)
	const add = appear === undefined ? undefined : addEffectsOp(slide.ref, [], [{ id: 5 }], { preset: appear, aspect: 16 / 9 })

	if (add === undefined) throw new Error("no effect")

	await run(d, add)

	const effects = slideEffects((await slideOf(d)).timing)
	const row =
		effects.kind === "effects" ? effects.rows.find(candidate => candidate.shape === 5 && candidate.trigger === undefined) : undefined

	if (row === undefined) throw new Error("no row")

	await run(d, {
		family: "timing",
		kind: "setEffectTiming",
		slide: slide.ref,
		node: row.id,
		timing: { trigger: { kind: "bookmark", shape: 4, bookmark: name } }
	})
}

// The slide's mc:AlternateContent holding its timing, with its Choice and Fallback timing.
function alternate(xml: string): { readonly whole: string; readonly choice: string; readonly fallback: string } | undefined {
	const whole = /<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>/u.exec(xml)?.[0]

	if (whole === undefined) return undefined

	return {
		whole,
		choice: /<mc:Choice\b[\s\S]*?<\/mc:Choice>/u.exec(whole)?.[0] ?? "",
		fallback: /<mc:Fallback\b[\s\S]*?<\/mc:Fallback>|<mc:Fallback\/>/u.exec(whole)?.[0] ?? ""
	}
}

describe("a slide timing in mc:AlternateContent", () => {
	it("is written back byte for byte by an undo of a media timing edit after a save", { timeout: 120_000 }, async () => {
		for (const [label, after] of [
			["bookmark trigger", AC_TIMING],
			["click trigger", AC_CLICK]
		] as const) {
			for (const op of ["setTrim", "setFade", "addBookmark"] as const) {
				const source = deck(after)
				const d = await driveSession(source, "pptx")
				const edit: DeckOp =
					op === "setTrim"
						? { family: "mediaTiming", kind: op, target: target(d), startMs: 2000, endMs: 500 }
						: op === "setFade"
							? { family: "mediaTiming", kind: op, target: target(d), inMs: 9, outMs: 9 }
							: { family: "mediaTiming", kind: op, target: target(d), name: "X", timeMs: 99 }

				await run(d, edit)

				const edited = slidePart(await saved(d))

				expect(count(edited, "<p:timing>"), `${label} ${op} edited`).toBe(2)

				await d.undo()

				const undone = slidePart(await saved(d))

				expect(count(undone, "<p:timing>"), `${label} ${op} undone`).toBe(2)
				expect(undone, `${label} ${op}`).toBe(slidePart(source))
			}
		}
	})

	it("is kept whole when a shape on the slide is restored from markup", { timeout: 60_000 }, async () => {
		const source = slidePart(deck(AC_TIMING))
		const box = /<p:sp><p:nvSpPr><p:cNvPr id="5"[\s\S]*?<\/p:sp>/u.exec(source)?.[0] ?? ""
		const pic = /<p:pic>[\s\S]*?<\/p:pic>/u.exec(source)?.[0] ?? ""

		for (const [id, raw] of [
			[5, box.replace('x="6000000"', 'x="6012700"')],
			[4, pic.replace('x="1000000"', 'x="1012700"')]
		] as const) {
			const d = await driveSession(deck(AC_TIMING), "pptx")

			await run(d, {
				family: "shape",
				kind: "restore",
				target: { slide: d.session.deck.slides[0] as never, id },
				raw: new TextEncoder().encode(raw)
			})

			const written = slidePart(await saved(d))

			expect(count(written, "<p:timing>"), String(id)).toBe(2)
			expect(alternate(written)?.whole, String(id)).toBe(alternate(source)?.whole)
		}
	})

	it(
		"rewrites the Choice and regenerates the Fallback when the timing changes, as one AlternateContent",
		{ timeout: 60_000 },
		async () => {
			const d = await driveSession(deck(AC_TIMING), "pptx")

			await bookmarkTrigger(d, "Intro")

			const bytes = await saved(d)
			const xml = slidePart(bytes)
			const ac = alternate(xml)

			expect(count(xml, "<p:timing>")).toBe(2)
			expect(count(xml, "<mc:AlternateContent")).toBe(1)
			expect(count(ac?.choice ?? "", "<p14:bmkTgt")).toBe(4)
			expect(ac?.choice).toContain('bmkName="Intro"')
			// The Fallback starts each bookmark-triggered sequence on a click of its clip, and holds nothing of p14.
			expect(ac?.fallback).not.toContain("p14")
			expect(ac?.fallback).not.toContain("onMediaBookmark")
			expect(count(ac?.fallback ?? "", '<p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="4"/></p:tgtEl></p:cond>')).toBe(4)
			expect(await modelVsFile(d, bytes, "pptx")).toBe("")

			const effects = slideEffects(slideNode(await openDeck(bytes), 0).timing)

			expect(effects.kind === "effects" ? effects.rows.map(row => row.bookmark) : []).toEqual(["Chorus", "Intro"])
		}
	)
})

describe("a new bookmark trigger", () => {
	it(
		"is written in mc:AlternateContent: the p14 Choice, and a Fallback started on a click of the clip",
		{ timeout: 120_000 },
		async () => {
			for (const after of [undefined, timing(CLICK_CONDITION)]) {
				const source = deck(after)
				const d = await driveSession(source, "pptx")

				await bookmarkTrigger(d, "Chorus")

				const bytes = await saved(d)
				const xml = slidePart(bytes)
				const ac = alternate(xml)

				expect(count(xml, "<p:timing>")).toBe(2)
				expect(ac?.choice).toMatch(/<mc:Choice [^>]*Requires="p14"/u)
				expect(ac?.choice).toContain(
					'<p14:bmkTgt xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" spid="4" bmkName="Chorus"/>'
				)
				expect(ac?.fallback).not.toContain("p14")
				expect(ac?.fallback).toContain('<p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="4"/></p:tgtEl></p:cond>')
				// Nothing of the timing is left outside it.
				expect(xml.replace(ac?.whole ?? "", "")).not.toContain("<p:timing")

				const reopened = slideEffects(slideNode(await openDeck(bytes), 0).timing)

				expect(reopened.kind === "effects" ? reopened.rows.filter(row => row.bookmark === "Chorus").length : 0).toBe(1)

				if (SDK_MISSING === undefined) {
					const sourcePath = join(scratch, "trigger-source.pptx")
					const savedPath = join(scratch, "trigger.pptx")

					writeFileSync(sourcePath, source)
					writeFileSync(savedPath, bytes)

					const sdk = new OpenXmlSdk()

					try {
						expect(
							newSdkErrors(
								sdkErrorCounts(await sdk.validate(sourcePath)),
								sdkErrorCounts(await sdk.validate(savedPath)),
								loadAllowlist()
							)
						).toEqual([])
					} finally {
						await sdk.close()
					}
				}
			}
		}
	)
})

describe("bookmarks the reader could not take", () => {
	// A 25 h bookmark (past the reader's day), one without a name, one whose time does not parse.
	const UNREAD =
		'<p14:bmkLst><p14:bmk name="Start" time="1000"/><p14:bmk name="Late" time="90000000"/><p14:bmk time="3000"/><p14:bmk name="Bad" time="soon"/></p14:bmkLst>'

	it("stay in the file in their places when the list is edited", { timeout: 60_000 }, async () => {
		const d = await driveSession(deck(undefined, UNREAD), "pptx")

		await run(d, { family: "mediaTiming", kind: "addBookmark", target: target(d), name: "New", timeMs: 2000 })
		await run(d, { family: "mediaTiming", kind: "removeBookmark", target: target(d), name: "Start" })

		const xml = slidePart(await saved(d))
		const list = /<p14:bmkLst>[\s\S]*?<\/p14:bmkLst>/u.exec(xml)?.[0]

		expect(list).toBe(
			'<p14:bmkLst><p14:bmk name="New" time="2000"/><p14:bmk name="Late" time="90000000"/><p14:bmk time="3000"/><p14:bmk name="Bad" time="soon"/></p14:bmkLst>'
		)
	})

	it("keep their names: a new bookmark cannot take one", async () => {
		const d = await driveSession(deck(undefined, UNREAD), "pptx")

		expect(await d.command({ family: "mediaTiming", kind: "addBookmark", target: target(d), name: "Late", timeMs: 5000 })).toEqual({
			ok: false,
			refusal: "unsupported"
		})
	})

	it("past the 256th stay too", { timeout: 60_000 }, async () => {
		let list = "<p14:bmkLst>"

		for (let k = 0; k < 258; k++) list += `<p14:bmk name="B${String(k)}" time="${String(1000 + k)}"/>`

		const d = await driveSession(deck(undefined, `${list}</p14:bmkLst>`), "pptx")

		await run(d, { family: "mediaTiming", kind: "removeBookmark", target: target(d), name: "B0" })

		const xml = slidePart(await saved(d))

		expect(count(xml, "<p14:bmk ")).toBe(257)
		expect(xml).toContain('<p14:bmk name="B257" time="1257"/>')
	})
})

describe("an undo", () => {
	it("restores what the file held, even where the editor would not set it", { timeout: 60_000 }, async () => {
		// Cuts that add up past a day; two bookmarks of one name.
		const d = await driveSession(
			deck(
				undefined,
				'<p14:trim st="86400000" end="86400000"/><p14:bmkLst><p14:bmk name="A" time="1000"/><p14:bmk name="A" time="2000"/></p14:bmkLst>'
			),
			"pptx"
		)

		await run(d, {
			family: "shape",
			kind: "setXfrm",
			target: target(d),
			xfrm: { x: 1, y: 1, cx: 4_000_000, cy: 3_000_000, rot: 0, flipH: false, flipV: false }
		})
		await run(d, { family: "mediaTiming", kind: "setTrim", target: target(d), startMs: 1000, endMs: 0 })
		await run(d, { family: "mediaTiming", kind: "removeBookmark", target: target(d), name: "A" })

		expect((await d.undo()).ok).toBe(true)
		expect((await d.undo()).ok).toBe(true)

		const media = (await slideOf(d)).shapes.find(shape => shape.id === 4)?.media

		expect(media?.timing?.trim).toEqual({ startMs: 86_400_000, endMs: 86_400_000 })
		expect(media?.timing?.bookmarks?.map(bookmark => bookmark.name)).toEqual(["A", "A"])
	})
})

describe("an OpenDocument copy", () => {
	it("starts a bookmark-triggered effect on a click of its clip, and names it in the losses", { timeout: 120_000 }, async () => {
		const opened = await openDeck(deck(AC_TIMING))
		const sink = memorySink()
		const out = await convertPresentation(opened.deck, { format: "pptx", parts: opened.parts, source: opened.source }, "odp", sink)

		if ("kind" in out) throw new Error(`${out.reason} ${out.detail ?? ""}`)

		const content = strFromU8(unzipSync(sink.bytes().slice())["content.xml"] ?? new Uint8Array())

		expect(content).not.toContain('smil:begin="indefinite"')
		expect(content).toMatch(/smil:begin="[^"]+\.click"/u)
		expect(out.losses.find(loss => loss.kind === "bookmarkTrigger")?.count).toBe(1)
	})
})

describe("an effect edit on a slide whose timing is in mc:AlternateContent", () => {
	it(
		"keeps every node's cTn attributes in the Choice and the regenerated Fallback (a trigger's cancelBubble)",
		{ timeout: 120_000 },
		async () => {
			for (const after of [
				AC_TIMING,
				AC_CLICK,
				timing(CLICK_CONDITION),
				timing(BOOKMARK_CONDITION).replace("<p:timing>", `<p:timing xmlns:p14="${P14}">`)
			]) {
				const d = await driveSession(deck(after), "pptx")

				await bookmarkTrigger(d, "Intro")

				const ac = alternate(slidePart(await saved(d)))

				for (const branch of [ac?.choice ?? "", ac?.fallback ?? ""]) {
					expect(count(branch, 'nodeType="interactiveSeq"')).toBe(2)
					expect(count(branch, 'evtFilter="cancelBubble"')).toBe(2)
				}
			}
		}
	)

	it("is undone to the source bytes, with or without a save between", { timeout: 240_000 }, async () => {
		for (const after of [AC_TIMING, AC_CLICK, timing(CLICK_CONDITION), undefined]) {
			for (const between of [false, true]) {
				for (const trigger of [true, false]) {
					const source = deck(after)
					const d = await driveSession(source, "pptx")
					let steps = 1

					if (trigger) {
						await bookmarkTrigger(d, "Chorus")
						steps = 2
					} else {
						const slide = await slideOf(d)
						const appear = EFFECT_PRESETS.find(preset => preset.presetClass === "entr" && preset.id === 1)
						const add =
							appear === undefined ? undefined : addEffectsOp(slide.ref, [], [{ id: 5 }], { preset: appear, aspect: 16 / 9 })

						if (add === undefined) throw new Error("no effect")

						await run(d, add)
					}

					if (between) await saved(d)

					for (let k = 0; k < steps; k++) expect((await d.undo()).ok).toBe(true)

					const { result, bytes } = await d.save()
					const label = `${after === undefined ? "none" : after.slice(0, 22)} between ${String(between)} trigger ${String(trigger)}`

					if (result.kind === "written") expect(slidePart(bytes ?? new Uint8Array()), label).toBe(slidePart(source))
					else expect(result.kind, label).toBe("unchanged")
				}
			}
		}
	})
})
