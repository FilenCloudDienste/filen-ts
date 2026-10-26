import type { EmbeddedFontRef, ListStyle, ModifyVerifier } from "../../presentation/model"
import { tooLarge } from "../../presentation/refusal"
import { readListStyle, relPart, type ReadContext } from "./drawing"
import { readEmbeddedFonts } from "./fonts"
import { G } from "./xml"

// The presentation part (p:presentation, ECMA-376 Part 1 §19.2.1.26): the slide, master, notes master and handout
// master lists, sizes, the default text style, embedded fonts and the write reservation.

export interface ListedPart {
	// p:sldId/@id, p:sldMasterId/@id (absent for notes and handout masters).
	readonly id: number
	readonly part: string
}

export interface PresentationRead {
	readonly size: { cx: number; cy: number; type?: string }
	readonly notesSize: { cx: number; cy: number }
	readonly firstSlideNumber: number
	readonly slides: readonly ListedPart[]
	readonly masters: readonly ListedPart[]
	readonly notesMaster: string | undefined
	readonly handoutMaster: string | undefined
	readonly defaultTextStyle: ListStyle
	readonly embeddedFonts: EmbeddedFontRef[]
	readonly modifyVerifier: ModifyVerifier | undefined
	readonly root: number
}

// MS-OI29500 §2.1.1110: PowerPoint's slide size when p:sldSz is absent; notes default to the portrait page.
const DEFAULT_SIZE = { cx: 9_144_000, cy: 6_858_000 }
const DEFAULT_NOTES = { cx: 6_858_000, cy: 9_144_000 }

function listed(context: ReadContext, list: number, local: string, limit: number, what: string): ListedPart[] {
	const r = context.reader
	const out: ListedPart[] = []
	const seen = new Set<string>()

	for (const entry of r.children(list, G.P, local)) {
		const part = relPart(context, r.rel(entry, "id"))

		// A missing target, or a part listed twice, is skipped (PowerPoint repairs both).
		if (part === undefined || seen.has(part.toLowerCase())) continue

		seen.add(part.toLowerCase())

		if (out.length >= limit) tooLarge(what, limit)

		out.push({ id: r.int(entry, "id") ?? 0, part })
	}

	return out
}

function modifyVerifier(context: ReadContext, node: number): ModifyVerifier | undefined {
	const r = context.reader

	if (node < 0) return undefined

	// ECMA-376 Part 1 §19.2.1.19: the agile form (algorithmName, hashValue, saltValue, spinValue), else the legacy
	// CryptoAPI form (cryptAlgorithmSid, hashData, saltData, spinCount).
	const algorithm =
		r.attr(node, "algorithmName") ??
		(r.attr(node, "cryptAlgorithmSid") === undefined ? "" : `sid:${r.attr(node, "cryptAlgorithmSid") ?? ""}`)

	return {
		algorithm,
		hash: r.attr(node, "hashValue") ?? r.attr(node, "hashData") ?? "",
		salt: r.attr(node, "saltValue") ?? r.attr(node, "saltData") ?? "",
		spinCount: r.int(node, "spinValue") ?? r.int(node, "spinCount") ?? 0
	}
}

export function readPresentation(context: ReadContext): PresentationRead {
	const r = context.reader
	const root = r.document.documentElement()
	const budgets = context.tally.budgets
	const sldSz = r.child(root, G.P, "sldSz")
	const notesSz = r.child(root, G.P, "notesSz")
	const type = r.attr(sldSz, "type")
	const notesMaster = listed(context, r.child(root, G.P, "notesMasterIdLst"), "notesMasterId", 1, "notes masters")[0]
	const handoutMaster = listed(context, r.child(root, G.P, "handoutMasterIdLst"), "handoutMasterId", 1, "handout masters")[0]
	const defaultTextStyle = r.child(root, G.P, "defaultTextStyle")

	return {
		size: {
			cx: sldSz < 0 ? DEFAULT_SIZE.cx : (r.int(sldSz, "cx") ?? DEFAULT_SIZE.cx),
			cy: sldSz < 0 ? DEFAULT_SIZE.cy : (r.int(sldSz, "cy") ?? DEFAULT_SIZE.cy),
			...(type === undefined ? {} : { type })
		},
		notesSize: {
			cx: notesSz < 0 ? DEFAULT_NOTES.cx : (r.int(notesSz, "cx") ?? DEFAULT_NOTES.cx),
			cy: notesSz < 0 ? DEFAULT_NOTES.cy : (r.int(notesSz, "cy") ?? DEFAULT_NOTES.cy)
		},
		firstSlideNumber: r.int(root, "firstSlideNum") ?? 1,
		slides: listed(context, r.child(root, G.P, "sldIdLst"), "sldId", budgets.slides, "slides"),
		masters: listed(context, r.child(root, G.P, "sldMasterIdLst"), "sldMasterId", budgets.masters, "slide masters"),
		notesMaster: notesMaster?.part,
		handoutMaster: handoutMaster?.part,
		defaultTextStyle: defaultTextStyle < 0 ? { levels: [] } : readListStyle(context, defaultTextStyle),
		embeddedFonts: readEmbeddedFonts(context, r.child(root, G.P, "embeddedFontLst")),
		modifyVerifier: modifyVerifier(context, r.child(root, G.P, "modifyVerifier")),
		root
	}
}
