import { refused, type ColorModel, type Refused, type ShowSettings } from "../../../presentation/model"
import { colorXml } from "../../../presentation/render/markup"
import type { XmlDocument, XmlEditor } from "../../../xml/index"
import { colorIn } from "../../read/drawing"
import { DEFAULT_SHOW } from "../../read/props"
import { G, P_MAIN, partReader, type PartReader } from "../../read/xml"
import type { PptxEmitFamily } from "../types"
import { sameModel, URIS } from "./shape"

// The presentation family writes presentation-level parts, never a slide's element: its emit is never asked for one.
export const emitPptxPresentation: PptxEmitFamily = {
	emit: () => refused("unsupported", "pptx emit presentation: no slide element")
}

const A_MAIN = URIS["a"] ?? ""
// p:kiosk@restart's default (ECMA-376 Part 1 §19.2.1.18).
const DEFAULT_RESTART = 300_000
const CHOICES: ReadonlySet<string> = new Set(["present", "browse", "kiosk"])
const RANGES: ReadonlySet<string> = new Set(["sldAll", "sldRg", "custShow"])
// showPr's attributes with their defaults (§19.2.1.30).
const FLAGS = [
	["loop", "loop", false],
	["showNarration", "showNarration", false],
	["showAnimation", "showAnimation", true],
	["useTimings", "useTimings", true]
] as const

function choiceMarkup(q: (local: string) => string, show: ShowSettings): string {
	return show.kind === "kiosk" && show.restartMs !== undefined
		? `<${q("kiosk")} restart="${String(show.restartMs)}"/>`
		: `<${q(show.kind)}/>`
}

function rangeMarkup(q: (local: string) => string, show: ShowSettings): string {
	const range = show.range

	switch (range.kind) {
		case "all":
			return `<${q("sldAll")}/>`
		case "range":
			return `<${q("sldRg")} st="${String(range.start)}" end="${String(range.end)}"/>`
		case "customShow":
			return `<${q("custShow")} id="${String(range.id)}"/>`
	}
}

function penMarkup(q: (local: string) => string, color: ColorModel, aBound: boolean): string {
	return `<${q("penClr")}${aBound ? "" : ` xmlns:a="${A_MAIN}"`}>${colorXml(color)}</${q("penClr")}>`
}

function qualifier(prefix: string): (local: string) => string {
	return local => (prefix === "" ? local : `${prefix}:${local}`)
}

// A whole p:showPr for the settings (a part without one).
export function showPrMarkup(show: ShowSettings, prefix = "p", declare = false, aBound = true): string {
	const q = qualifier(prefix)
	const flags = FLAGS.map(([name, key, fallback]) => (show[key] === fallback ? "" : ` ${name}="${show[key] ? "1" : "0"}"`)).join("")
	const pen = show.penColor === undefined ? "" : penMarkup(q, show.penColor, aBound)

	return `<${q("showPr")}${declare ? ` xmlns:${prefix}="${P_MAIN}"` : ""}${flags}>${choiceMarkup(q, show)}${rangeMarkup(q, show)}${pen}</${q("showPr")}>`
}

function firstOf(r: PartReader, parent: number, locals: ReadonlySet<string>): number {
	for (let child = r.first(parent); child >= 0; child = r.next(child))
		if (r.group(child) === G.P && locals.has(r.local(child))) return child

	return -1
}

function setNumber(r: PartReader, editor: XmlEditor, node: number, name: string, value: number): void {
	if (r.int(node, name) !== value) editor.setAttribute(node, name, String(value))
}

// p:showPr of a p:presentationPr (ECMA-376 Part 1 §19.2.1.30) made to say `show`, the smallest edit: its attributes set
// in place (unknown ones kept), the mode and range elements edited or replaced, p:penClr kept when it holds the same
// colour, p:extLst and anything else untouched. A part whose showPr already says `show` is left unedited.
export function spliceShowPr(document: XmlDocument, editor: XmlEditor, show: ShowSettings): Refused | undefined {
	const r = partReader(document)
	const root = document.documentElement()

	if (show.restartMs !== undefined && show.kind !== "kiosk") return refused("unsupported", "a restart outside kiosk mode")
	if (r.namespaces.elementUri(root) !== P_MAIN || document.localName(root) !== "presentationPr")
		return refused("unsupported", "presProps.xml is not a Transitional p:presentationPr")

	const showPr = r.child(root, G.P, "showPr")

	if (showPr < 0) return insertShowPr(r, editor, root, show)

	const colon = document.name(showPr).indexOf(":")
	const q = qualifier(colon < 0 ? "" : document.name(showPr).slice(0, colon))

	for (const [name, key, fallback] of FLAGS) {
		const written = r.bool(showPr, name)

		if ((written ?? fallback) !== show[key]) editor.setAttribute(showPr, name, show[key] ? "1" : "0")
	}

	// Elements to write where the source has none, in schema order, flushed before the next source element kept.
	let pending = ""
	const flush = (before: number): void => {
		if (pending === "") return

		editor.insertBefore(before, pending)
		pending = ""
	}

	const choice = firstOf(r, showPr, CHOICES)

	if (choice < 0) {
		if (show.kind !== "present") pending += choiceMarkup(q, show)
	} else if (r.local(choice) !== show.kind) {
		editor.replace(choice, choiceMarkup(q, show))
	} else if (show.kind === "kiosk" && (r.int(choice, "restart") ?? DEFAULT_RESTART) !== (show.restartMs ?? DEFAULT_RESTART)) {
		editor.setAttribute(choice, "restart", String(show.restartMs ?? DEFAULT_RESTART))
	}

	const range = firstOf(r, showPr, RANGES)
	const wanted = show.range
	const local = wanted.kind === "all" ? "sldAll" : wanted.kind === "range" ? "sldRg" : "custShow"

	if (range < 0) {
		if (wanted.kind !== "all") pending += rangeMarkup(q, show)
	} else {
		flush(range)

		if (r.local(range) !== local) editor.replace(range, rangeMarkup(q, show))
		else if (wanted.kind === "range") {
			setNumber(r, editor, range, "st", wanted.start)
			setNumber(r, editor, range, "end", wanted.end)
		} else if (wanted.kind === "customShow") setNumber(r, editor, range, "id", wanted.id)
	}

	const pen = r.child(showPr, G.P, "penClr")
	const aBound = r.namespaces.prefixFor(showPr, A_MAIN) === "a"

	if (pen < 0) {
		if (show.penColor !== undefined) pending += penMarkup(q, show.penColor, aBound)
	} else {
		flush(pen)

		if (show.penColor === undefined) editor.remove(pen)
		else if (!sameModel(colorIn(r, pen), show.penColor)) editor.replace(pen, penMarkup(q, show.penColor, aBound))
	}

	if (pending !== "") {
		const extLst = r.child(showPr, G.P, "extLst")

		if (extLst >= 0) flush(extLst)
		else editor.append(showPr, pending)
	}

	return undefined
}

// A new p:showPr at its place in CT_PresentationProperties (htmlPubPr, webPr, prnPr, showPr, clrMru, extLst); none when
// the settings are the defaults a part without one already means.
function insertShowPr(r: PartReader, editor: XmlEditor, root: number, show: ShowSettings): undefined {
	if (sameModel(show, DEFAULT_SHOW)) return undefined

	const prefix = r.namespaces.prefixFor(root, P_MAIN)
	const markup = showPrMarkup(show, prefix ?? "p", prefix === undefined, r.namespaces.prefixFor(root, A_MAIN) === "a")
	const before = [r.child(root, G.P, "clrMru"), r.child(root, G.P, "extLst")].find(node => node >= 0)
	const after = [r.child(root, G.P, "prnPr"), r.child(root, G.P, "webPr"), r.child(root, G.P, "htmlPubPr")].find(node => node >= 0)

	if (after !== undefined) editor.insertAfter(after, markup)
	else if (before !== undefined) editor.insertBefore(before, markup)
	else editor.append(root, markup)

	return undefined
}
