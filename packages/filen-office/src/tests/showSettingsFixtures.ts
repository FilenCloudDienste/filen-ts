import { expect } from "vitest"
import { applyOp, type ApplyContext } from "../core/presentation/edit/apply"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type Deck, type ShowSettings } from "../core/presentation/model"
import { body, buildPptx, para, sp } from "./pptxFixtures"
import { Changes, openDeck, save } from "./pptxWriteFixtures"
import { changes as odpChanges, openOdpDeck, saveDeck } from "./odpWriteFixtures"

// Decks for the Set Up Slide Show tests: a pptx of four slides with a custom show (and presProps.xml when given), the
// setShow op applied the way the edit session applies it, and the deck saved in place and read again.

export const PRES_PROPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps"
export const PRES_PROPS_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"
const ROOT =
	'<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" xmlns:x="urn:example:keep">'
export const PEN = '<p:penClr><a:prstClr val="red"/></p:penClr>'
export const EXT_LST = '<p:extLst><p:ext uri="{2FDB2607-1784-4EEB-B798-7EB5836EED8A}"><p14:showMediaCtrls val="1"/></p:ext></p:extLst>'
export const SOURCE_SHOW_PR = `<p:showPr x:keep="yes" showNarration="1"><p:present/><p:sldAll/>${PEN}${EXT_LST}</p:showPr>`
export const CLR_MRU = '<p:clrMru><a:srgbClr val="123456"/></p:clrMru>'
const SHOWS =
	'<p:custShowLst><p:custShow name="Short" id="0"><p:sldLst><p:sld r:id="rId102"/><p:sld r:id="rId103"/></p:sldLst></p:custShow></p:custShowLst>'

export const DEFAULTS: ShowSettings = {
	kind: "present",
	loop: false,
	showNarration: false,
	showAnimation: true,
	useTimings: true,
	range: { kind: "all" }
}

export function pptxBytes(presProps: string | undefined): Uint8Array {
	return buildPptx({
		slides: [1, 2, 3, 4].map(n => ({ shapes: sp(2, "Title 1", 'type="title"', "", body(para(`Slide ${String(n)}`))) })),
		presentation: SHOWS,
		...(presProps === undefined
			? {}
			: {
					presentationRels: [["rId70", PRES_PROPS, "presProps.xml"]] as const,
					parts: { "ppt/presProps.xml": { data: `${ROOT}${presProps}</p:presentationPr>`, type: PRES_PROPS_TYPE } }
				})
	})
}

export const context: ApplyContext = {
	sourceBytes: () => new Uint8Array(0),
	newShapeId: () => 100,
	newSlideRef: () => slideRef(99)
}

export function setShow(show: ShowSettings): DeckOp {
	return { family: "presentation", kind: "setShow", show }
}

export function apply(deck: Deck, show: ShowSettings): ReturnType<typeof applyOp> {
	return applyOp(deck, setShow(show), context)
}

export async function savedPptxShow(
	bytes: Uint8Array,
	show: ShowSettings
): Promise<{ readonly show: ShowSettings; readonly bytes: Uint8Array }> {
	const opened = await openDeck(bytes)

	expect(apply(opened.deck, show)).toMatchObject({ kind: "applied" })

	const saved = await save(opened, new Changes().deck("show").build())

	expect(saved.outcome).toMatchObject({ kind: "written" })

	return { show: (await openDeck(saved.bytes)).deck.show, bytes: saved.bytes }
}

// The ODP deck saved after setShow: its bytes and the settings read back.
export async function savedOdpShow(
	bytes: Uint8Array,
	show: ShowSettings
): Promise<{ readonly show: ShowSettings; readonly bytes: Uint8Array }> {
	const opened = await openOdpDeck(bytes)

	expect(apply(opened.deck, show)).toMatchObject({ kind: "applied" })

	const saved = await saveDeck(opened, odpChanges("show"))

	expect(saved.outcome).toMatchObject({ kind: "written" })

	return { show: (await openOdpDeck(saved.bytes)).deck.show, bytes: saved.bytes }
}
