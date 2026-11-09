import { describe, expect, it } from "vitest"
import { memorySink } from "@filen/office/core/opc"
import { applyOp, opTouches } from "../core/presentation/edit/apply"
import type { ShowSettings } from "../core/presentation/model"
import { odfShow } from "../core/odp/write/emit/presentation"
import { freshPptx } from "../core/pptx/write/fresh"
import { Changes, openDeck, partsOf, save, saveEdits, text } from "./pptxWriteFixtures"
import { changes as odpChanges, entriesOf, ODP_DECK, openOdpDeck, saveDeck, text as odpText } from "./odpWriteFixtures"
import { odpBytes } from "./odpFixtures"
import { freshFromPptx } from "./odpWriteFreshFixtures"
import { editHarness } from "./presentationEditFixtures"
import {
	apply,
	CLR_MRU,
	context,
	DEFAULTS,
	EXT_LST,
	PEN,
	PRES_PROPS,
	PRES_PROPS_TYPE,
	pptxBytes,
	savedOdpShow as savedOdp,
	savedPptxShow,
	setShow,
	SOURCE_SHOW_PR
} from "./showSettingsFixtures"

// Set Up Slide Show: the setShow op, its undo, and the settings written by every save path (pptx in place and fresh,
// ODP in place and fresh), read back by the readers.

describe("Set Up Slide Show op", () => {
	it("replaces the deck's show settings, touches only them, and its inverse puts back the ones it replaced", async () => {
		const { deck } = await openDeck(pptxBytes(SOURCE_SHOW_PR))
		const before = structuredClone(deck.show)
		const next: ShowSettings = { ...DEFAULTS, kind: "kiosk", loop: true, restartMs: 60_000, range: { kind: "range", start: 2, end: 3 } }
		const result = apply(deck, next)

		if (result.kind !== "applied") throw new Error(`refused: ${result.reason}`)

		expect(deck.show).toEqual(next)
		expect(opTouches(setShow(next))).toEqual([{ kind: "presentation", what: "show" }])

		for (const back of result.inverse.ops) applyOp(deck, back, context)

		expect(deck.show).toEqual(before)
	})

	it("refuses settings the deck cannot hold with a typed reason, leaving its settings as they were", async () => {
		const { deck } = await openDeck(pptxBytes(undefined))
		const cases: [ShowSettings, string][] = [
			[{ ...DEFAULTS, range: { kind: "range", start: 0, end: 2 } }, "malformed"],
			[{ ...DEFAULTS, range: { kind: "range", start: 3, end: 2 } }, "malformed"],
			[{ ...DEFAULTS, range: { kind: "range", start: 2, end: 5 } }, "notFound"],
			[{ ...DEFAULTS, range: { kind: "customShow", id: 7 } }, "notFound"],
			[{ ...DEFAULTS, kind: "kiosk", restartMs: Number.NaN }, "malformed"],
			[{ ...DEFAULTS, kind: "kiosk", restartMs: Number.POSITIVE_INFINITY }, "malformed"],
			[{ ...DEFAULTS, kind: "kiosk", restartMs: -1 }, "malformed"],
			[{ ...DEFAULTS, kind: "kiosk", restartMs: 4_294_967_296 }, "malformed"],
			[{ ...DEFAULTS, restartMs: 1000 }, "unsupported"]
		]

		for (const [show, reason] of cases) {
			expect(apply(deck, show), JSON.stringify(show)).toMatchObject({ kind: "refused", reason })
			expect(deck.show).toEqual(DEFAULTS)
		}
	})

	it("refuses on an ODP deck what ODF presentation settings cannot say", async () => {
		const { deck } = await openOdpDeck(odpBytes(ODP_DECK))
		const before = structuredClone(deck.show)

		for (const show of [
			{ ...DEFAULTS, kind: "kiosk" },
			{ ...DEFAULTS, showNarration: true },
			{ ...DEFAULTS, penColor: { kind: "srgb", rgb: "FF0000" } },
			{ ...DEFAULTS, range: { kind: "range", start: 1, end: 2 } },
			{ ...DEFAULTS, restartMs: 5000 }
		] satisfies ShowSettings[]) {
			expect(apply(deck, show), JSON.stringify(show)).toMatchObject({ kind: "refused", reason: "unsupported" })
		}

		expect(deck.show).toEqual(before)
	})

	it("sends the new settings to the page with the change, on the command and on its undo", async () => {
		const harness = await editHarness(pptxBytes(SOURCE_SHOW_PR))
		const next: ShowSettings = { ...DEFAULTS, loop: true }

		expect(await harness.command(setShow(next))).toMatchObject({ ok: true })
		expect(harness.events.at(-1)).toMatchObject({ type: "changed", info: { show: next } })
		expect((harness.events.at(-1) as { info?: object }).info).not.toHaveProperty("slides")

		await harness.undo()

		expect(harness.events.at(-1)).toMatchObject({ type: "changed", info: { show: { ...DEFAULTS, showNarration: true } } })
		harness.close()
	})
})

describe("Set Up Slide Show in a pptx save", () => {
	it("saves each show type, the slide range and a custom show into presProps.xml, read back as set", async () => {
		const cases: ShowSettings[] = [
			{ ...DEFAULTS, kind: "kiosk", loop: true, restartMs: 60_000, penColor: { kind: "preset", name: "red" } },
			{ ...DEFAULTS, kind: "browse", showAnimation: false, useTimings: false, penColor: { kind: "preset", name: "red" } },
			{ ...DEFAULTS, range: { kind: "range", start: 2, end: 3 }, showNarration: true, penColor: { kind: "preset", name: "red" } },
			{ ...DEFAULTS, range: { kind: "customShow", id: 0 }, loop: true }
		]

		for (const show of cases) expect((await savedPptxShow(pptxBytes(SOURCE_SHOW_PR), show)).show, JSON.stringify(show)).toEqual(show)
	})

	it("keeps the source's pen colour, extension list, unknown attributes and siblings byte for byte", async () => {
		const { bytes } = await savedPptxShow(pptxBytes(`${SOURCE_SHOW_PR}${CLR_MRU}`), {
			...DEFAULTS,
			kind: "kiosk",
			restartMs: 120_000,
			showNarration: true,
			range: { kind: "range", start: 1, end: 4 },
			penColor: { kind: "preset", name: "red" }
		})
		const props = text((await partsOf(bytes)).get("ppt/presProps.xml"))

		expect(props).toContain(`${PEN}${EXT_LST}</p:showPr>${CLR_MRU}`)
		expect(props).toContain('x:keep="yes"')
		expect(props).toContain('<p:kiosk restart="120000"/><p:sldRg st="1" end="4"/>')
	})

	it("writes another pen colour and drops the pen colour the settings no longer carry", async () => {
		const blue: ShowSettings = { ...DEFAULTS, showNarration: true, penColor: { kind: "srgb", rgb: "0000FF" } }

		expect((await savedPptxShow(pptxBytes(SOURCE_SHOW_PR), blue)).show).toEqual(blue)

		const none = await savedPptxShow(pptxBytes(SOURCE_SHOW_PR), { ...DEFAULTS, showNarration: true })

		expect(none.show).toEqual({ ...DEFAULTS, showNarration: true })
		expect(text((await partsOf(none.bytes)).get("ppt/presProps.xml"))).toContain(`<p:sldAll/>${EXT_LST}`)
	})

	it("adds presProps.xml with its relationship and content type to a package that has none", async () => {
		const show: ShowSettings = { ...DEFAULTS, kind: "browse", loop: true }
		const saved = await savedPptxShow(pptxBytes(undefined), show)
		const parts = await partsOf(saved.bytes)

		expect(saved.show).toEqual(show)
		expect(text(parts.get("[Content_Types].xml"))).toContain(`PartName="/ppt/presProps.xml" ContentType="${PRES_PROPS_TYPE}"`)
		expect(text(parts.get("ppt/_rels/presentation.xml.rels"))).toContain(PRES_PROPS)
	})

	it("adds no presProps.xml to a package without one when the settings are the defaults", async () => {
		const opened = await openDeck(pptxBytes(undefined))

		expect(apply(opened.deck, { ...DEFAULTS })).toMatchObject({ kind: "applied" })

		const saved = await save(opened, new Changes().deck("show").build())

		if (saved.outcome.kind === "written") expect((await partsOf(saved.bytes)).has("ppt/presProps.xml")).toBe(false)
		else expect(saved.outcome).toEqual({ kind: "unchanged" })
	})

	it("saves the settings an edit session set, and the save after it reads them back", async () => {
		const harness = await editHarness(pptxBytes(SOURCE_SHOW_PR))
		const show: ShowSettings = { ...DEFAULTS, kind: "kiosk", restartMs: 30_000, range: { kind: "customShow", id: 0 } }

		expect(await harness.command(setShow(show))).toMatchObject({ ok: true })

		const saved = await saveEdits(harness, 1)

		expect((await openDeck(saved)).deck.show).toEqual(show)
		harness.close()
	})

	it("writes the deck's settings, not the source's, into a fresh package", async () => {
		const opened = await openDeck(pptxBytes(SOURCE_SHOW_PR))
		const show: ShowSettings = { ...DEFAULTS, kind: "browse", loop: true, range: { kind: "range", start: 2, end: 4 } }

		expect(apply(opened.deck, show)).toMatchObject({ kind: "applied" })

		const sink = memorySink()
		const outcome = await freshPptx(opened.deck, opened.source, sink, {})

		expect(outcome).toMatchObject({ kind: "written" })
		expect((await openDeck(sink.bytes())).deck.show).toEqual(show)
		expect(text((await partsOf(sink.bytes())).get("ppt/presProps.xml"))).toContain(EXT_LST)

		const bare = await openDeck(pptxBytes(undefined))
		const kiosk: ShowSettings = { ...DEFAULTS, kind: "kiosk", restartMs: 45_000 }

		expect(apply(bare.deck, kiosk)).toMatchObject({ kind: "applied" })

		const second = memorySink()

		expect(await freshPptx(bare.deck, bare.source, second, {})).toMatchObject({ kind: "written" })
		expect((await openDeck(second.bytes())).deck.show).toEqual(kiosk)
	})
})

describe("Set Up Slide Show in an ODP save", () => {
	async function savedOdpShow(bytes: Uint8Array, show: ShowSettings): Promise<{ readonly show: ShowSettings; readonly content: string }> {
		const saved = await savedOdp(bytes, show)

		return { show: saved.show, content: odpText((await entriesOf(saved.bytes)).get("content.xml")) }
	}

	it("saves looping with its pause, manual advance, animations off and a window into presentation:settings", async () => {
		const show: ShowSettings = { ...DEFAULTS, kind: "browse", loop: true, restartMs: 10_000, useTimings: false, showAnimation: false }
		const saved = await savedOdpShow(odpBytes(ODP_DECK), show)

		expect(saved.show).toEqual(show)
		expect(saved.content).toContain('presentation:pause="PT10S"')
		expect(saved.content).toContain('<presentation:show presentation:name="Short" presentation:pages="Intro,End"/>')
	})

	it("saves a start page and a custom show, each read back as set", async () => {
		const start: ShowSettings = { ...DEFAULTS, range: { kind: "range", start: 3, end: 3 } }

		expect((await savedOdpShow(odpBytes(ODP_DECK), start)).show).toEqual(start)

		const custom = await savedOdpShow(odpBytes(ODP_DECK), { ...DEFAULTS, range: { kind: "customShow", id: 0 } })

		expect(custom.show).toEqual({ ...DEFAULTS, range: { kind: "customShow", id: 0 } })
		expect(custom.content).not.toContain("presentation:start-page")

		const all = await savedOdpShow(odpBytes(ODP_DECK), { ...DEFAULTS })

		expect(all.show).toEqual(DEFAULTS)
	})

	it("writes presentation:settings into a content.xml that has none", async () => {
		const bare = { ...ODP_DECK, body: ODP_DECK.body.replace(/<presentation:settings.*<\/presentation:settings>/u, "") }
		const show: ShowSettings = { ...DEFAULTS, loop: true, range: { kind: "range", start: 2, end: 3 } }
		const saved = await savedOdpShow(odpBytes(bare), show)

		expect(saved.show).toEqual(show)
		expect(saved.content).toContain(
			'<presentation:settings presentation:endless="true" presentation:start-page="Middle"></presentation:settings>'
		)
	})

	it("refuses a save of settings ODF cannot say rather than drop them", async () => {
		const opened = await openOdpDeck(odpBytes(ODP_DECK))

		opened.deck.show = { ...DEFAULTS, kind: "kiosk" }

		expect((await saveDeck(opened, odpChanges("show"))).outcome).toMatchObject({ kind: "refused", reason: "unsupported" })
	})

	it("writes the nearest settings into a fresh ODP and reports what ODF cannot hold", async () => {
		const fresh = await freshFromPptx(
			pptxBytes(
				'<p:showPr loop="1" showNarration="1"><p:kiosk restart="60000"/><p:sldRg st="2" end="3"/><p:penClr><a:prstClr val="red"/></p:penClr></p:showPr>'
			)
		)

		if ("kind" in fresh) throw new Error(`refused: ${fresh.reason}`)

		expect(fresh.report.approximated).toMatchObject({ "kiosk mode": 1, "slide range end": 1 })
		expect(fresh.report.omitted).toMatchObject({ narration: 1, "pen colour": 1, "kiosk restart": 1 })
		expect((await openOdpDeck(fresh.bytes)).deck.show).toEqual({ ...DEFAULTS, loop: true, range: { kind: "range", start: 2, end: 4 } })
	})

	it("converts a kiosk show into an ODP that loops on its timings, as a kiosk always does", async () => {
		const deck = (await openDeck(pptxBytes(undefined))).deck
		const { show } = odfShow(deck, { ...DEFAULTS, kind: "kiosk", loop: false, useTimings: false })

		expect(show).toMatchObject({ kind: "present", loop: true, useTimings: true })

		const fresh = await freshFromPptx(pptxBytes('<p:showPr useTimings="0"><p:kiosk/></p:showPr>'))

		if ("kind" in fresh) throw new Error(`refused: ${fresh.reason}`)

		expect(fresh.report.approximated).toMatchObject({ "kiosk mode": 1 })
		expect((await openOdpDeck(fresh.bytes)).deck.show).toEqual({ ...DEFAULTS, loop: true })
	})
})
