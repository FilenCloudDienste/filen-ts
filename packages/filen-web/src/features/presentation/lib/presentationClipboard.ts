import {
	clipHtml,
	clipIdOf,
	clipPartNames,
	clipPlainText,
	pasteShapesOp,
	pasteSlidesOps,
	xmlSafeText,
	type DeckOp,
	type Format,
	type PasteRefusal,
	type PresentationClip,
	type PresentationRefusal,
	type SlideRef,
	type Xfrm
} from "@filen/office/core/presentation"
import type { ClipPartsResult, PresentationSessionApi } from "@filen/office/dom/presentation"
import type { PreviewKey } from "@/lib/i18n"

// The presentation editor's clipboard, one for every open deck (PowerPoint keeps one clipboard for all its windows):
// the clip the last Cut or Copy made, with the session it came from, so a paste reaches another deck. The system
// clipboard gets its text, HTML naming the clip, and a picture where there is one; a paste reads the clipboard and
// pastes the clip when the HTML on it names it (or, where the browser gives no HTML back, its text is the clip's),
// else the other app's picture or text.

export interface HeldClip {
	readonly id: string
	readonly clip: PresentationClip
	// The deck's session it came from (its parts are asked for by a paste into another deck).
	readonly source: Pick<PresentationSessionApi, "clipParts">
}

let held: HeldClip | undefined

export function holdClip(clip: PresentationClip, source: HeldClip["source"], id: string = crypto.randomUUID()): HeldClip {
	held = { id, clip, source }

	return held
}

export function heldClip(): HeldClip | undefined {
	return held
}

// The clip a closing deck's session made goes with it when a paste elsewhere would need that session (its parts).
export function releaseClipsOf(source: HeldClip["source"]): void {
	if (held?.source !== source) return

	const clip = held.clip

	if (clip.kind === "slides" || clipPartNames(clip).length > 0) held = undefined
}

export function forgetClips(): void {
	held = undefined
}

// What a copy gives the system clipboard: its text and HTML naming it.
export function clipboardPayload(clip: HeldClip): { readonly text: string; readonly html: string } {
	return { text: clipPlainText(clip.clip.text), html: clipHtml(clip.id, clip.clip.text) }
}

// What the clipboard holds as a paste reads it; null: the browser gave nothing (a read it refused).
export interface PastedData {
	readonly text: string
	readonly html: string
	readonly files: readonly File[]
}

// The held clip a paste of `data` pastes: the one its HTML names; with no HTML read back (a browser that hands a page
// text only), the held clip when the text is its own; with nothing read at all, the held clip.
export function clipOfPaste(data: PastedData | null, clip: HeldClip | undefined = held): HeldClip | undefined {
	if (clip === undefined) return undefined
	if (data === null) return clip

	const id = clipIdOf(data.html)

	if (id !== undefined) return id === clip.id ? clip : undefined

	return data.html === "" && data.files.length === 0 && data.text !== "" && data.text === clipboardPayload(clip).text ? clip : undefined
}

export type ClipboardScope = "shapes" | "slides"

export type PastePlan =
	| { readonly kind: "shapes"; readonly slide: SlideRef; readonly op: DeckOp }
	| { readonly kind: "slides"; readonly ops: readonly DeckOp[]; readonly select: number }
	| { readonly kind: "refused"; readonly reason: PasteRefusal | PresentationRefusal }

export interface PasteTarget {
	readonly session: Pick<PresentationSessionApi, "clipParts">
	readonly format: Format
	readonly order: readonly SlideRef[]
	// The slide in view and its index.
	readonly current: number
	readonly slide: SlideRef | undefined
	// Its shapes' boxes.
	readonly boxes: readonly Xfrm[]
}

// The parts a shape clip of another deck names, asked of the deck it came from.
async function partsOf(clip: HeldClip, names: readonly string[]): Promise<ClipPartsResult> {
	if (names.length === 0) return { ok: true, parts: [] }

	try {
		return await clip.source.clipParts(names)
	} catch {
		// Its deck closed meanwhile.
		return { ok: false, refusal: "notFound" }
	}
}

// What a paste of `clip` does here: shapes onto the slide in view, slides after it.
export async function planPaste(clip: HeldClip, target: PasteTarget): Promise<PastePlan> {
	const sameDeck = clip.source === target.session
	const made = clip.clip

	if (made.kind === "slides") {
		const ops = pasteSlidesOps(made, target.order, target.current, sameDeck)

		return typeof ops === "string" ? { kind: "refused", reason: ops } : { kind: "slides", ops, select: target.current + 1 }
	}

	if (target.slide === undefined) return { kind: "refused", reason: "notFound" }

	const names = sameDeck ? [] : clipPartNames(made)
	const parts = await partsOf(clip, names)

	if (!parts.ok) return { kind: "refused", reason: parts.refusal }

	const op = pasteShapesOp(made, {
		slide: target.slide,
		boxes: target.boxes,
		sameDeck,
		format: target.format,
		parts: new Map(parts.parts.map(part => [part.name, part] as const))
	})

	return typeof op === "string" ? { kind: "refused", reason: op } : { kind: "shapes", slide: target.slide, op }
}

// Another app's text pasted on the slide: a text box holding it, a paragraph a line (what XML cannot carry taken out).
export function pastedTextOp(op: DeckOp, text: string): DeckOp {
	if (op.family !== "shape" || op.kind !== "insert" || op.shape.text === undefined) return op

	const body = op.shape.text
	const first = body.paragraphs[0] ?? { pPr: {}, runs: [] }
	const lines = text.replace(/\r\n?/gu, "\n").replace(/\n$/u, "").split("\n")
	const paragraphs = lines.map(line => {
		const clean = xmlSafeText(line.replace(/\t/gu, " "))

		return { ...first, runs: clean === "" ? [] : [{ kind: "r" as const, text: clean, rPr: {} }] }
	})

	return { ...op, shape: { ...op.shape, text: { ...body, paragraphs } } }
}

// The message a refused Cut, Copy or Paste shows.
export function clipboardRefusalKey(reason: PasteRefusal | PresentationRefusal, pasting: boolean): PreviewKey {
	switch (reason) {
		case "locked":
			return "previewPptxEditorRefusedLocked"
		case "unsupported":
			return pasting ? "previewPptxClipboardNotHere" : "previewPptxClipboardNotCopied"
		case "notFound":
		case "stale":
			return pasting ? "previewPptxClipboardGone" : "previewPptxEditorRefusedStale"
		case "tooLarge":
			return "previewPptxClipboardTooLarge"
		case "viewOnly":
			return "previewPptxEditorRefusedViewOnly"
		default:
			return "previewPptxEditorRefused"
	}
}
