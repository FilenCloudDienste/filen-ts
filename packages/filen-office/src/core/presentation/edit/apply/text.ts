import { classifyHref } from "../../actions"
import { DEFAULT_PRESENTATION_BUDGETS } from "../../budget"
import { resolveShape } from "../../inherit"
import {
	refused,
	type Deck,
	type Paragraph,
	type Refused,
	type RunProps,
	type ShapeNode,
	type ShapeRef,
	type SlideNode,
	type SourceRef,
	type TextBody
} from "../../model"
import type { ApplyContext, ApplyFamily, ApplyResult, Inverse, Touch } from "../apply"
import { cloneModel, digestOf, findShape } from "../changes"
import { matcherOf, replaceInBody } from "../find"
import type { DeckOp, OpOf, TextOp } from "../ops"
import { isRefused, type SourceReading } from "./shape"
import { applyTable, replaceInFrame } from "./table"
import { remapParagraphs } from "./timing"

// The text ops on the model, in place. setText puts a whole new body on one shape; its inverse is a setText of the
// body it had, with the shape's source markup as bytes when that body came from the source (`raw`), so an undo after
// a save's rebase re-reads the body from those bytes instead of naming paragraphs of a document that is gone. A body
// built on the page from a TextSeed names source paragraphs of the epoch it was seeded in: a stale ref is rebound to
// the live paragraph with the same content, or dropped (the paragraph is written from the model); content kept as
// source with a stale ref cannot be written and refuses the op. setAutofitResult writes the worker's autofit result
// (normAutofit's fontScale and lnSpcReduction, spAutoFit's height). replace replaces a query in several bodies as one
// step (edit/find.ts).

type SetText = OpOf<"text"> & { kind: "setText" }
type SetAutofit = OpOf<"text"> & { kind: "setAutofitResult" }
type Replace = OpOf<"text"> & { kind: "replace" }

const BUDGETS = DEFAULT_PRESENTATION_BUDGETS
const AUTOFIT_UNIT = 100_000

function reading(context: ApplyContext): SourceReading | undefined {
	return "readShape" in context ? (context as SourceReading) : undefined
}

function textTouch(target: ShapeRef): Touch {
	return { kind: "shape", slide: target.slide, shape: target.id, dirt: { kind: "text" } }
}

// The shape a text op edits: parsed, of a kind that holds a body, not locked.
function editable(deck: Deck, target: ShapeRef): { readonly node: SlideNode; readonly shape: ShapeNode } | Refused {
	const node = deck.nodes.get(target.slide)

	if (node === undefined) return refused("notFound", `slide ${String(target.slide)} is not parsed`)

	const shape = findShape(node.shapes, target.id)?.shape

	if (shape === undefined) return refused("notFound", `shape ${String(target.id)}`)
	if (shape.kind !== "sp") return refused("unsupported", `a ${shape.kind} holds no text body`)
	if (shape.lock !== undefined) return refused("locked", shape.lock)

	return { node, shape }
}

function live(src: SourceRef, context: ApplyContext): boolean {
	return !isRefused(context.sourceBytes(src))
}

// Characters XML 1.0 cannot hold (§2.2): such text would never be written, so it never enters the model.
function invalidXml(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index)

		if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffe || code === 0xffff) return true
	}

	return false
}

// A run's link: a URL one only as the save proof classifies it (http, https, mailto) and with text XML can hold.
function carriableLinks(rPr: RunProps): boolean {
	const action = rPr.hlinkClick

	return action?.kind !== "url" || (!invalidXml(action.href) && classifyHref(action.href).kind === "url")
}

// A body over the hostile-input budgets, or holding text XML cannot, is refused before it enters the model.
function checkBody(body: TextBody): Refused | undefined {
	let runs = 0

	for (const paragraph of body.paragraphs) {
		runs += paragraph.runs.length

		if (runs > BUDGETS.runsPerBody) return refused("tooLarge", `${String(runs)} runs in one body`)

		for (const run of paragraph.runs) {
			if (run.kind !== "br" && invalidXml(run.text)) return refused("malformed", "text holds a character XML cannot")
			if (run.kind !== "opaque" && !carriableLinks(run.rPr)) return refused("malformed", "a link the deck cannot carry")
		}
	}

	return undefined
}

function paragraphDigest(paragraph: Paragraph): string {
	return digestOf({ pPr: paragraph.pPr, runs: paragraph.runs, endRPr: paragraph.endRPr })
}

function staleOpaque(paragraph: Paragraph, context: ApplyContext): boolean {
	return paragraph.runs.some(run => run.kind === "opaque" && !live(run.src, context))
}

// The op's body with every source ref live: a stale paragraph ref takes the live ref of a current paragraph with the
// same content (each once), or goes; a stale ref of kept content refuses.
function rebind(body: TextBody, current: TextBody | undefined, context: ApplyContext): TextBody | Refused {
	const stale = body.paragraphs.some(
		paragraph => (paragraph.src !== undefined && !live(paragraph.src, context)) || staleOpaque(paragraph, context)
	)

	if (!stale) return body

	const candidates = new Map<string, Paragraph[]>()

	for (const paragraph of current?.paragraphs ?? []) {
		if (paragraph.src === undefined || !live(paragraph.src, context)) continue

		const key = paragraphDigest(paragraph)
		const list = candidates.get(key)

		if (list === undefined) candidates.set(key, [paragraph])
		else list.push(paragraph)
	}

	const paragraphs: Paragraph[] = []
	const kept = keptContent(current, context)

	for (const paragraph of body.paragraphs) {
		if ((paragraph.src === undefined || live(paragraph.src, context)) && !staleOpaque(paragraph, context)) {
			paragraphs.push(paragraph)
			continue
		}

		const match = candidates.get(paragraphDigest(paragraph))?.shift()

		if (match !== undefined) {
			// Its kept content is its own: never bound into another paragraph too.
			for (const run of match.runs) {
				if (run.kind !== "opaque") continue

				const list = kept.get(digestOf(run))
				const at = list?.indexOf(run.src) ?? -1

				if (at >= 0) list?.splice(at, 1)
			}

			paragraphs.push(match)
			continue
		}

		const runs = staleOpaque(paragraph, context) ? liveRuns(paragraph, kept, context) : paragraph.runs

		if (runs === undefined) return refused("stale", "content kept as source of another epoch")

		const { src: _stale, ...rest } = paragraph

		paragraphs.push(paragraph.src !== undefined && live(paragraph.src, context) ? { ...paragraph, runs } : { ...rest, runs })
	}

	return { ...body, paragraphs }
}

// The kept content of the current body by its digest (its text; source refs left out), in body order, with live refs.
function keptContent(body: TextBody | undefined, context: ApplyContext): Map<string, SourceRef[]> {
	const out = new Map<string, SourceRef[]>()

	for (const paragraph of body?.paragraphs ?? []) {
		for (const run of paragraph.runs) {
			if (run.kind !== "opaque" || !live(run.src, context)) continue

			const key = digestOf(run)
			const list = out.get(key)

			if (list === undefined) out.set(key, [run.src])
			else list.push(run.src)
		}
	}

	return out
}

// A paragraph's runs with each stale kept content bound to the next live one alike in the current body (kept content
// is never edited, only moved or deleted with its paragraph); undefined when one has none left.
function liveRuns(paragraph: Paragraph, kept: Map<string, SourceRef[]>, context: ApplyContext): Paragraph["runs"] | undefined {
	const runs: Paragraph["runs"] = []

	for (const run of paragraph.runs) {
		if (run.kind !== "opaque" || live(run.src, context)) {
			runs.push(run)
			continue
		}

		const src = kept.get(digestOf(run))?.shift()

		if (src === undefined) return undefined

		runs.push({ ...run, src })
	}

	return runs
}

// The source markup of a shape whose body is (partly) source, for an inverse; undefined when nothing in it names the
// source.
function rawOf(shape: ShapeNode, context: ApplyContext): Uint8Array | Refused | undefined {
	const text = shape.text

	if (shape.src === undefined || text === undefined) return undefined

	const sourced = text.paragraphs.some(paragraph => paragraph.src !== undefined || paragraph.runs.some(run => run.kind === "opaque"))

	if (!sourced) return undefined

	const bytes = context.sourceBytes(shape.src)

	return isRefused(bytes) ? bytes : bytes.slice()
}

// The inverse of a body change on one shape: its body as it is now (none: an empty one), with its source bytes.
function bodyInverse(target: ShapeRef, shape: ShapeNode, context: ApplyContext): SetText | Refused {
	const raw = rawOf(shape, context)

	if (isRefused(raw)) return raw

	const prior: TextBody = shape.text === undefined ? { bodyPr: {}, paragraphs: [] } : cloneModel(shape.text)

	return { family: "text", kind: "setText", target, body: prior, ...(raw === undefined ? {} : { raw }) }
}

// The body a setText puts in: the op's own with its refs live, or, when it carries the source bytes of a body whose
// refs went stale with a rebase, the body read back from those bytes.
function bodyToPut(node: SlideNode, shape: ShapeNode, op: SetText, context: ApplyContext): TextBody | Refused {
	const body = cloneModel(op.body)
	const bound = rebind(body, shape.text, context)

	if (op.raw === undefined || !isRefused(bound)) return bound

	const reader = reading(context)

	if (reader === undefined) return refused("stale", "source markup cannot be read back here")

	const read = reader.readShape(node, op.raw)

	if (isRefused(read)) return read

	const from = read.text !== undefined && digestOf(read.text) === digestOf(body) ? read.text : rebind(body, read.text, context)

	return isRefused(from) ? from : keptInPlace(from, shape, context)
}

// Content kept as source that was read back from held markup, bound to the same content in the shape's live source
// (byte for byte), so the writer copies it from the part it writes; held markup is written only as a whole shape. Kept
// content the live source no longer has cannot be written into it and refuses the op.
function keptInPlace(body: TextBody, shape: ShapeNode, context: ApplyContext): TextBody | Refused {
	const part = shape.src?.format === "pptx" ? shape.src.part : undefined
	const held = (src: SourceRef): boolean => src.format === "pptx" && src.part !== part

	if (!body.paragraphs.some(paragraph => paragraph.runs.some(run => run.kind === "opaque" && held(run.src)))) return body

	const live: { readonly bytes: Uint8Array; readonly src: SourceRef }[] = []

	for (const paragraph of shape.text?.paragraphs ?? []) {
		for (const run of paragraph.runs) {
			if (run.kind !== "opaque" || held(run.src)) continue

			const bytes = context.sourceBytes(run.src)

			if (!isRefused(bytes)) live.push({ bytes, src: run.src })
		}
	}

	const paragraphs: Paragraph[] = []

	for (const paragraph of body.paragraphs) {
		const runs: Paragraph["runs"] = []

		for (const run of paragraph.runs) {
			if (run.kind !== "opaque" || !held(run.src)) {
				runs.push(run)
				continue
			}

			const bytes = context.sourceBytes(run.src)
			const at = isRefused(bytes) ? -1 : live.findIndex(entry => sameBytes(entry.bytes, bytes))
			const found = live[at]

			if (found === undefined) return refused("stale", "content kept as source that the saved file no longer holds")

			live.splice(at, 1)
			runs.push({ ...run, src: found.src })
		}

		paragraphs.push({ ...paragraph, runs })
	}

	return { ...body, paragraphs }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false

	for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false

	return true
}

function inverseOf(ops: readonly DeckOp[]): Inverse {
	let bytes = 0

	for (const op of ops) if (op.family === "text" && op.kind === "setText" && op.raw !== undefined) bytes += op.raw.length

	return { ops, bytes }
}

// An empty body with nothing of its own is no body (an a:txBody PowerPoint would not write).
function putBody(node: SlideNode, shape: ShapeNode, body: TextBody): void {
	if (body.paragraphs.length === 0 && Object.keys(body.bodyPr).length === 0 && body.lstStyle === undefined) delete shape.text
	else shape.text = body

	node.revision++
}

function setText(deck: Deck, op: SetText, context: ApplyContext): ApplyResult<SetText> {
	// A table cell's body (the text editor open on a cell): the table family's setCellText.
	if (op.target.cell !== undefined) {
		const { cell, ...frame } = op.target
		const result = applyTable.apply(
			deck,
			{
				family: "table",
				kind: "setCellText",
				target: frame,
				row: cell.row,
				col: cell.col,
				body: op.body,
				...(op.burst === undefined ? {} : { burst: op.burst }),
				...(op.raw === undefined ? {} : { raw: op.raw })
			},
			context
		)

		return result.kind === "refused" ? result : { kind: "applied", inverse: result.inverse, op }
	}

	const found = editable(deck, op.target)

	if (isRefused(found)) return found

	const checked = checkBody(op.body)

	if (checked !== undefined) return checked

	const back = bodyInverse(op.target, found.shape, context)

	if (isRefused(back)) return back

	const body = bodyToPut(found.node, found.shape, op, context)

	if (isRefused(body)) return body

	const before = found.shape.text

	putBody(found.node, found.shape, body)

	// By-paragraph effects move with their paragraphs (apply/timing.ts); the inverse puts the timing back after the body.
	const timing = remapParagraphs(deck.format, found.node, op.target.id, before, found.shape.text, context)

	if (timing === undefined) return { kind: "applied", inverse: inverseOf([back]), op }

	const inverse = inverseOf([back, ...timing.ops])

	return { kind: "applied", inverse: { ops: inverse.ops, bytes: inverse.bytes + timing.bytes }, op }
}

function setAutofit(deck: Deck, op: SetAutofit, context: ApplyContext): ApplyResult<SetAutofit> {
	const found = editable(deck, op.target)

	if (isRefused(found)) return found

	const { node, shape } = found
	const back: DeckOp[] = []
	const scaled = op.fontScale !== undefined || op.lnSpcReduction !== undefined
	const xfrm = op.height === undefined ? undefined : (shape.xfrm ?? resolveShape(deck, node.ref, shape).xfrm)

	if (op.height !== undefined && xfrm === undefined) return refused("unsupported", "a shape without a box grows nowhere")

	if (scaled) {
		const inverse = bodyInverse(op.target, shape, context)

		if (isRefused(inverse)) return inverse

		back.push(inverse)
	}

	if (xfrm !== undefined)
		back.push({ family: "shape", kind: "setXfrm", target: op.target, xfrm: shape.xfrm === undefined ? undefined : { ...shape.xfrm } })

	if (scaled) {
		const body: TextBody = shape.text ?? { bodyPr: {}, paragraphs: [] }
		const bodyPr = { ...body.bodyPr, autofit: "normal" as const }

		if (op.fontScale !== undefined) bodyPr.fontScale = Math.max(0.01, Math.min(1, op.fontScale / AUTOFIT_UNIT))
		if (op.lnSpcReduction !== undefined) bodyPr.lineSpacingReduction = Math.max(0, Math.min(1, op.lnSpcReduction / AUTOFIT_UNIT))

		shape.text = { ...body, bodyPr }
	}

	if (xfrm !== undefined && op.height !== undefined) shape.xfrm = { ...xfrm, cy: Math.max(0, Math.round(op.height)) }

	node.revision++

	return { kind: "applied", inverse: inverseOf(back.reverse()), op }
}

function replace(deck: Deck, op: Replace, context: ApplyContext): ApplyResult<Replace> {
	const matcher = matcherOf(op)

	if (matcher === undefined) return refused("malformed", "an empty query")

	const back: DeckOp[] = []
	const applied: Replace["targets"][number][] = []
	const puts: (() => void)[] = []
	let heldBytes = 0

	for (const entry of op.targets) {
		let target = entry.target

		// A table's cells (edit/apply/table.ts): one frame, every match in its cells, undone as one.
		if (entry.notes !== true && isTable(deck, target)) {
			const replaced = replaceInFrame(deck, target, matcher, op.replacement, entry.match, context)

			if (replaced === undefined) return refused("stale", "the match is no longer there")
			if (isRefused(replaced)) return replaced
			if (replaced.count === 0) continue

			back.push({ family: "batch", kind: "batch", ops: replaced.inverse.ops })
			heldBytes += replaced.inverse.bytes
			applied.push(entry)
			puts.push(replaced.put)

			continue
		}

		if (entry.notes === true) {
			const notes = deck.nodes.get(target.slide)?.notes

			if (notes === undefined) return refused("notFound", `notes of slide ${String(target.slide)}`)

			target = { slide: notes, id: target.id }
		}

		const found = editable(deck, target)

		if (isRefused(found)) return found

		const text = found.shape.text
		const replaced = text === undefined ? undefined : replaceInBody(text, matcher, op.replacement, entry.match)

		if (replaced === undefined) {
			if (entry.match !== undefined) return refused("stale", "the match is no longer there")

			continue
		}

		if (replaced.count === 0) continue

		const checked = checkBody(replaced.body)

		if (checked !== undefined) return checked

		const inverse = bodyInverse(target, found.shape, context)

		if (isRefused(inverse)) return inverse

		back.push(inverse)
		applied.push({ target, ...(entry.match === undefined ? {} : { match: entry.match }) })
		puts.push(() => putBody(found.node, found.shape, replaced.body))
	}

	// Nothing changes before every target is known to apply.
	for (const put of puts) put()

	const inverse = inverseOf(back.reverse())

	return { kind: "applied", inverse: { ops: inverse.ops, bytes: inverse.bytes + heldBytes }, op: { ...op, targets: applied } }
}

function isTable(deck: Deck, target: ShapeRef): boolean {
	const node = deck.nodes.get(target.slide)

	return node !== undefined && findShape(node.shapes, target.id)?.shape.frame?.kind === "table"
}

export const applyText: ApplyFamily<TextOp> = {
	apply: (deck, op, context) => {
		switch (op.kind) {
			case "setText":
				return setText(deck, op, context)
			case "setAutofitResult":
				return setAutofit(deck, op, context)
			case "replace":
				return replace(deck, op, context)
		}
	},
	touches: op => {
		switch (op.kind) {
			case "setText":
				return [textTouch(op.target)]
			case "setAutofitResult": {
				const touches: Touch[] = []

				if (op.fontScale !== undefined || op.lnSpcReduction !== undefined) touches.push(textTouch(op.target))
				if (op.height !== undefined)
					touches.push({ kind: "shape", slide: op.target.slide, shape: op.target.id, dirt: { kind: "xfrm" } })

				return touches
			}
			case "replace":
				// A notes target names its slide until applied (the op as applied names the notes slide's ref): the slide is
				// named so it is parsed with its notes; a touch whose fingerprint does not change is never dirty.
				return op.targets.map(entry =>
					entry.notes === true
						? ({ kind: "slide", slide: entry.target.slide, dirt: { kind: "slidePart", part: "attributes" } } as const)
						: textTouch(entry.target)
				)
		}
	}
}
