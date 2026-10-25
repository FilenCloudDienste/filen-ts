import type { Node } from "prosemirror-model"
import type { EditorState, Transaction } from "prosemirror-state"
import {
	AddNodeMarkStep,
	AttrStep,
	DocAttrStep,
	RemoveNodeMarkStep,
	ReplaceAroundStep,
	ReplaceStep,
	type Step
} from "prosemirror-transform"
import { markStepTypes, markStepsOf } from "./marks"
import { Ns } from "../model/namespaces"
import type { DocxModel, StoryPart } from "../model/index"
import { Item } from "../model/kinds"
import { controlAround, pictureSwap, typeable } from "../forms/controls"
import type { PropsStore } from "../props/index"
import { SetAttrsStep } from "./attrs"
import { RebuildStep } from "./invariants/core"
import { DOCX_PARAGRAPH_STYLES, PARAGRAPH_STYLE_NAMES, type DocxEditorCommandType, type DocxParagraphStyle } from "./commands"
import { canonicalStyleName } from "../styles/styles"
import type { DocxEditContext } from "./context"
import { docxSchema, NO_SOURCE, type MarkerKind, type MarkerList } from "./schema"
import { sectionNode } from "../stories/sections"
import { rowGrid } from "./tables/map"
import type { DocxEditorSession } from "./session"
import type { DocxGateReason } from "../package"
import { readProtectionHash, type ProtectionHashRead } from "../protection/hash"

// Document protection that allows editing within limits (ECMA-376 Part 1 §17.15.1.29 w:documentProtection
// with w:enforcement on): "forms" lets only content controls and legacy form fields change, plus the ranges an
// editing permission opens to everyone (§17.13.7.2 w:permStart w:edGrp "everyone"); "comments" lets only
// comments change, plus those ranges; "trackedChanges" records every edit as a tracked change: the switch cannot
// be turned off and changes cannot be accepted or rejected (Word's behaviour); "readOnly" lets only those ranges
// change, and keeps a document without them view-only (gate 0 reason "protected"). The password hash is kept as
// it is: editing within the limits needs no password.

export type DocxProtectionMode = "none" | "forms" | "comments" | "trackedChanges" | "readOnly"

export interface DocxProtection {
	readonly mode: DocxProtectionMode
	// Tracking cannot be switched off (trackedChanges).
	readonly forcesTracking: boolean
	// The protection carries a password hash (kept as written).
	readonly hashed: boolean
}

export const NO_PROTECTION: DocxProtection = { mode: "none", forcesTracking: false, hashed: false }

const LIMITED_MODES = new Set<string>(["forms", "comments", "trackedChanges"])
const protections = new WeakMap<DocxEditContext, DocxProtection>()

// The mode an enforced w:documentProtection w:edit opens the document in ("none" for the view-only and
// unprotected ones).
export function protectionMode(edit: string | undefined, enforced: boolean): DocxProtectionMode {
	return enforced && edit !== undefined && LIMITED_MODES.has(edit) ? (edit as DocxProtectionMode) : "none"
}

export function protectionOf(context: DocxEditContext): DocxProtection {
	let found = protections.get(context)

	if (found === undefined) {
		const protection = context.model.package.facts.documentProtection
		// A read-only document gate 0 let through (ranges open to everyone in it): only those ranges change.
		const mode =
			protection === undefined
				? "none"
				: protection.enforced && protection.edit === "readOnly" && !context.gate.includes("protected")
					? "readOnly"
					: protectionMode(protection.edit, protection.enforced)

		found =
			mode === "none"
				? NO_PROTECTION
				: Object.freeze({ mode, forcesTracking: mode === "trackedChanges", hashed: protection?.hashed ?? false })
		protections.set(context, found)
	}

	return found
}

// w:writeProtection (ECMA-376 Part 1 §17.15.1.93): Word's "password to modify" and "read-only recommended".
// A password keeps the document view-only (gate 0 reason "writeProtected") until the user gives it: the app
// checks it (dom/protection.ts) and opens the document again with EditContextParts.writeUnlocked, which lifts
// the reason for that session. A recommendation alone gates nothing here: the app offers it as Word does on
// open ("Edit anyway"). Either way the element is written back as it is (the password is not changed or
// removed). Write protection is not a security measure ([MS-OFFCRYPTO] §4.1.4).
export interface DocxWriteProtection {
	readonly recommended: boolean
	// The password's hash ("unsupported": one that cannot be checked here); undefined without a password.
	readonly password: ProtectionHashRead
}

export function writeProtectionOf(context: DocxEditContext): DocxWriteProtection | undefined {
	const pkg = context.model.package
	const facts = pkg.facts.writeProtection

	if (facts === undefined) return undefined

	return {
		recommended: facts.recommended,
		password: facts.hashed ? (readProtectionHash(pkg.settings, "writeProtection") ?? "unsupported") : undefined
	}
}

// Whether gate 0 reason `reason` is lifted for a session opened with `parts`.
export function gateLifted(reason: DocxGateReason, parts: { readonly writeUnlocked?: boolean }): boolean {
	return reason === "writeProtected" && parts.writeUnlocked === true
}

// Commands each mode allows; any other write command is refused (undo and redo stay: they only take back what
// the mode allowed).
const FORM_FILLING = new Set<DocxEditorCommandType>([
	"control.check",
	"control.choose",
	"control.date",
	"control.clear",
	"control.text",
	"control.item.add",
	"control.item.remove"
])
const COMMENTING = new Set<DocxEditorCommandType>([
	"comment.add",
	"comment.reply",
	"comment.edit",
	"comment.resolve",
	"comment.reopen",
	"comment.delete",
	"comment.next",
	"comment.prev"
])
const NOT_WHILE_TRACKED = new Set<DocxEditorCommandType>([
	"review.track",
	"review.accept",
	"review.reject",
	"review.acceptAll",
	"review.rejectAll"
])

// Commands that apply direct formatting: to text and paragraphs, tables and pictures.
const DIRECT_FORMATTING =
	/^(?:format|font|color|align|paragraph|list)\.|^table\.(?:align|cell\.shading|cell\.vAlign|column\.width|distributeColumns)$|^drawing\.(?:resize|position|wrap|rotate|crop)$/

// Commands whose effect is not limited to the selection (the document's changes, fields, notes, sections, headers
// and footers, page setup): refused under protection that limits edits to ranges or controls, whatever the
// selection, as Word disables them in a protected document.
const DOCUMENT_WIDE = new Set<DocxEditorCommandType>([
	"review.track",
	"review.accept",
	"review.reject",
	"review.acceptAll",
	"review.rejectAll",
	"field.updateAll",
	"toc.insert",
	"toc.update",
	"note.insertFootnote",
	"note.insertEndnote",
	"note.delete",
	"note.convert",
	"note.convertAll",
	"note.options",
	"page.setup",
	"insert.sectionBreak",
	"section.deleteBreak",
	"header.edit",
	"header.remove",
	"header.differentFirst",
	"header.differentOddEven",
	"header.linkToPrevious",
	"footer.edit",
	"footer.remove"
])

// Enforced formatting restrictions (w:documentProtection w:formatting): no direct formatting, as Word allows only
// styles then ("Limit formatting to a selection of styles", Microsoft Q&A answers by Word MVPs).
export function formattingRestricted(context: DocxEditContext): boolean {
	const protection = context.model.package.facts.documentProtection

	return protection !== undefined && protection.enforced && protection.formatting
}

// Whether a style is locked against use (w:locked, ECMA-376 Part 1 §17.7.4.7; a built-in style the document does
// not define by its w:lsdException, else w:latentStyles w:defLockedState, §17.7.4.5): under enforced formatting
// restrictions only unlocked styles apply (Word's "Limit formatting to a selection of styles"). `name`: a style
// added for a command and not yet in the styles part.
export function styleLocked(context: DocxEditContext, id: string | null, type: "paragraph" | "table" = "paragraph"): boolean {
	const styles = context.styles
	const style = id === null ? styles.defaultOf(type) : styles.byId(id)

	if (style !== undefined) return style.locked

	const name = id === null ? undefined : context.newStyles.get(id)

	if (name === undefined) return false

	const latent = styles.latent

	return latent.exceptions.get(canonicalStyleName(name))?.locked ?? latent.defaultLocked
}

// The paragraph styles a style picker offers: under enforced formatting restrictions, only unlocked ones.
export function offeredParagraphStyles(context: DocxEditContext): readonly DocxParagraphStyle[] {
	if (!formattingRestricted(context)) return DOCX_PARAGRAPH_STYLES

	const styles = context.styles
	const latent = styles.latent

	return DOCX_PARAGRAPH_STYLES.filter(style => {
		if (style === "normal") return !(styles.defaultOf("paragraph")?.locked ?? false)

		const name = PARAGRAPH_STYLE_NAMES[style]
		const defined = styles.byName(name, "paragraph")

		return !(defined !== undefined ? defined.locked : (latent.exceptions.get(canonicalStyleName(name))?.locked ?? latent.defaultLocked))
	})
}

// Why a transaction applies a locked style under enforced formatting restrictions, or undefined.
export function lockedStyleViolation(tr: Transaction, context: DocxEditContext): string | undefined {
	if (!formattingRestricted(context)) return undefined

	for (const [k, step] of tr.steps.entries()) {
		if (step instanceof SetAttrsStep) {
			for (const entry of step.entries) {
				if ("styleId" in entry.attrs && styleLocked(context, (entry.attrs["styleId"] as string | null) ?? null))
					return "lockedStyle"
			}
		} else if (step instanceof AttrStep && step.attr === "styleId") {
			const node = (tr.docs[k] as Node).nodeAt(step.pos)
			const type = node?.type === docxSchema.nodes.table ? "table" : "paragraph"

			if (styleLocked(context, (step.value as string | null) ?? null, type)) return "lockedStyle"
		}
	}

	return undefined
}

// Whether write command `type` may run on `session` (the story being edited) under the document's protection.
// Other story commands than the mode's own run only where the selection lies in a range open to everyone.
export function commandAllowed(session: DocxEditorSession, type: DocxEditorCommandType): boolean {
	const protection = protectionOf(session.context)

	// Direct formatting under enforced formatting restrictions (w:formatting): Word applies only styles then.
	if (formattingRestricted(session.context) && DIRECT_FORMATTING.test(type)) return false

	switch (protection.mode) {
		case "none":
			return true
		case "trackedChanges":
			return !NOT_WHILE_TRACKED.has(type)
	}

	// The track switch is the user's under read-only protection, from an open range as Word has it; anything
	// else reaching beyond the selection is refused whatever story it runs in.
	if (DOCUMENT_WIDE.has(type) && !(protection.mode === "readOnly" && type === "review.track")) return false

	switch (protection.mode) {
		case "forms":
			if (FORM_FILLING.has(type)) return true
			break
		case "comments":
			if (COMMENTING.has(type) || session.story.story.kind === "comment") return true
			break
		case "readOnly":
			break
	}

	if (type === "history.undo" || type === "history.redo") return true

	const selection = session.state.selection

	return permissionRanges(session).covers(session.state.doc, selection.from, selection.to)
}

// ---- editing permission ranges --------------------------------------------------------------------------

// ST_EdGrp (ECMA-376 Part 1 §17.18.24): only "everyone" is known to hold whoever edits; membership of the other
// groups (editors, owners...) is the server's to tell.
const OPEN_GROUPS = new Set(["everyone"])

// Ranges of a story's document an editing permission opens to everyone (pairs of positions), kept through
// every transaction the session applies: the ranges' markers always survive, so their positions move with the
// edits.
export class PermissionRanges {
	private ranges: number[]
	private doc: Node

	constructor(session: DocxEditorSession) {
		this.doc = session.state.doc
		this.ranges = openRanges(session.story.part, this.doc, session.context.store)

		// Under forms protection, sections whose w:formProt is off stay editable (ECMA-376 Part 1 §17.6.6).
		if (protectionOf(session.context).mode === "forms" && session.story.story.kind === "body") {
			const sections = openSections(session.story.part, this.doc)

			if (sections.length > 0) this.ranges = sortRanges([...this.ranges, ...sections])
		}
		session.onApplied((transactions, state) => {
			for (const tr of transactions) {
				if (!tr.docChanged || this.ranges.length === 0) continue

				for (let k = 0; k < this.ranges.length; k += 2) {
					this.ranges[k] = tr.mapping.map(this.ranges[k] ?? 0, -1)
					this.ranges[k + 1] = tr.mapping.map(this.ranges[k + 1] ?? 0, 1)
				}
			}

			this.doc = state.doc
		})
	}

	// Whether [from, to] lies in an open range of `ranges` (by default the session document's).
	covers(doc: Node, from: number, to: number, ranges: readonly number[] = this.of(doc)): boolean {
		for (let k = 0; k < ranges.length; k += 2) {
			if ((ranges[k] ?? 0) <= from && to <= (ranges[k + 1] ?? -1)) return true
		}

		return false
	}

	// The ranges of `doc` when it is the session's document (none for any other).
	of(doc: Node): readonly number[] {
		return doc === this.doc ? this.ranges : []
	}
}

const permissions = new WeakMap<DocxEditorSession, PermissionRanges>()

export function permissionRanges(session: DocxEditorSession): PermissionRanges {
	let found = permissions.get(session)

	if (found === undefined) {
		found = new PermissionRanges(session)
		permissions.set(session, found)
	}

	return found
}

// Whether a read-only document has ranges open to everyone (Word lets those be edited, ECMA-376 Part 1
// §17.13.7.2): gate 0 lets such a document through, protection limiting edits to the ranges.
export function readOnlyExceptions(model: DocxModel): boolean {
	for (const part of model.parts) {
		for (let item = 0; item < part.count; item++) if (part.kinds[item] === Item.PermissionStart && openStart(part, item)) return true
	}

	return false
}

// Whether w:permStart item `item` opens its range to everyone (a range for one named user, w:ed, does not:
// the editor cannot tell who edits).
function openStart(part: StoryPart, item: number): boolean {
	if (item === NO_SOURCE || item >= part.count) return false

	const group = part.reader.attr(part.node(item), Ns.W, "edGrp")

	return group !== undefined && OPEN_GROUPS.has(group)
}

// The table columns a w:permStart limits its range to (w:colFirst and w:colLast, zero-based grid columns, both
// given: ECMA-376 Part 1 §17.13.7.2), or undefined.
function columnsOf(part: StoryPart, item: number): { first: number; last: number } | undefined {
	const node = part.node(item)
	const first = Number.parseInt(part.reader.attr(node, Ns.W, "colFirst") ?? "", 10)
	const last = Number.parseInt(part.reader.attr(node, Ns.W, "colLast") ?? "", 10)

	return Number.isInteger(first) && Number.isInteger(last) && first >= 0 && last >= first ? { first, last } : undefined
}

// The content of the cells in [from, to] whose first grid column lies in `columns`, as ranges.
function columnRanges(
	part: StoryPart,
	store: PropsStore,
	doc: Node,
	from: number,
	to: number,
	columns: { first: number; last: number }
): number[] {
	const out: number[] = []

	doc.nodesBetween(from, to, (node, pos) => {
		if (node.type !== docxSchema.nodes.table_row) return !node.isTextblock && node.type !== docxSchema.nodes.table_cell

		let column = rowGrid(part, store, node).before

		node.forEach((cell, offset) => {
			const at = pos + 1 + offset

			if (column >= columns.first && column <= columns.last) out.push(at + 1, at + cell.nodeSize - 1)

			column += Math.max(1, (cell.attrs["colspan"] as number | undefined) ?? 1)
		})

		return false
	})

	return out
}

function sortRanges(ranges: readonly number[]): number[] {
	const pairs: [number, number][] = []

	for (let k = 0; k < ranges.length; k += 2) pairs.push([ranges[k] ?? 0, ranges[k + 1] ?? 0])

	return pairs.sort((a, b) => a[0] - b[0]).flat()
}

// Whether a section's properties (w:sectPr element `sectPr`) turn form protection off for it: w:formProt
// present and off (Word writes w:formProt w:val="0" for a section left out of the protection).
function formProtOff(part: StoryPart, sectPr: number): boolean {
	const node = sectPr < 0 ? -1 : part.reader.child(sectPr, Ns.W, "formProt")

	return node >= 0 && !part.reader.onOff(node)
}

// The body's sections form protection leaves editable, as ranges.
function openSections(part: StoryPart, doc: Node): number[] {
	const out: number[] = []
	let start = 0

	doc.descendants((node, pos) => {
		if (!node.isTextblock) return node.type === docxSchema.nodes.sdt

		const item = (node.attrs["sectPr"] as number | undefined) ?? NO_SOURCE

		if (item !== NO_SOURCE) {
			if (formProtOff(part, sectionNode(part, item))) out.push(start, pos + node.nodeSize)

			start = pos + node.nodeSize
		}

		return false
	})

	if (formProtOff(part, sectionNode(part, (doc.attrs["sectPr"] as number | undefined) ?? NO_SOURCE))) out.push(start, doc.content.size)

	return out
}

// The open ranges of `doc`, by one walk over its markers (once per session, under protection only).
function openRanges(part: StoryPart, doc: Node, store: PropsStore): number[] {
	const starts = new Map<string, { pos: number; item: number }>()
	const pairs: [number, number][] = []
	const visit = (list: MarkerList, pos: number): void => {
		for (const marker of list) {
			if (marker.id === null) continue

			if (marker.kind === "permissionStart") {
				if (openStart(part, marker.src)) starts.set(marker.id, { pos, item: marker.src })
			} else if (marker.kind === "permissionEnd") {
				const start = starts.get(marker.id)

				if (start !== undefined) {
					const columns = columnsOf(part, start.item)

					if (columns === undefined) pairs.push([start.pos, pos])
					else {
						const cells = columnRanges(part, store, doc, start.pos, pos, columns)

						for (let k = 0; k < cells.length; k += 2) pairs.push([cells[k] ?? 0, cells[k + 1] ?? 0])
					}

					starts.delete(marker.id)
				}
			}
		}
	}

	const walk = (node: Node, pos: number): void => {
		if (node.type === docxSchema.nodes.marker) {
			const kind = node.attrs["kind"] as MarkerKind

			if (kind === "permissionStart" || kind === "permissionEnd")
				visit([{ src: node.attrs["src"] as number, kind, id: node.attrs["id"] as string | null }], pos + 1)

			return
		}

		if (!node.isBlock) return

		const before = node.attrs["before"] as MarkerList | undefined
		const end = node.attrs["end"] as MarkerList | undefined

		if (before !== undefined && before.length > 0) visit(before, pos)
		if (!node.isAtom) node.forEach((child, offset) => walk(child, pos + 1 + offset))
		if (end !== undefined && end.length > 0 && !node.isTextblock) visit(end, pos + node.nodeSize - 1)
	}

	doc.forEach((child, offset) => walk(child, offset))

	const end = doc.attrs["end"] as MarkerList | undefined

	if (end !== undefined && end.length > 0) visit(end, doc.content.size)

	return pairs.sort((a, b) => a[0] - b[0]).flat()
}

// ---- transactions ---------------------------------------------------------------------------------------

// What a step touches, as [from, to] ranges of the document it applies to; undefined for steps no protection
// lets through (document attributes).
function stepRanges(step: Step, doc: Node): number[] | undefined {
	// A rebuild touches what its replaces do (the nodes it puts back are the same), and the text it leaves marked
	// deleted.
	if (step instanceof RebuildStep) return [...step.replaces.flatMap(replace => [replace.from, replace.to]), ...step.touched]
	if (step instanceof ReplaceStep) return [step.from, step.to]
	if (step instanceof ReplaceAroundStep) return [step.from, step.to]

	const parts = markStepsOf(step)

	if (parts !== undefined) return parts.flatMap(part => [part.from, part.to])
	if (step instanceof AttrStep || step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep) {
		const node = doc.nodeAt(step.pos)

		return node === null ? undefined : [step.pos, step.pos + node.nodeSize]
	}

	if (step instanceof SetAttrsStep) {
		const out: number[] = []

		step.eachNode(doc, (node, pos) => out.push(pos, pos + node.nodeSize))

		return out
	}

	return undefined
}

// A form command setting the state of a block control, or the state and result of a legacy form field.
function controlStateStep(step: Step, doc: Node): boolean {
	if (!(step instanceof AttrStep)) return false

	const node = doc.nodeAt(step.pos)

	if (node?.type === docxSchema.nodes.sdt) return step.attr === "state"

	return node?.type === docxSchema.nodes.field && (step.attr === "state" || step.attr === "result")
}

// Why `tr` (a transaction about to be applied to `state`, the session's) edits outside what the document's
// protection allows, or undefined. `form`: a form command's, which may change any control's content.
export function protectionViolation(
	tr: Transaction,
	session: DocxEditorSession,
	form = false,
	state: EditorState = session.state
): string | undefined {
	const mode = protectionOf(session.context).mode

	if (mode === "none" || mode === "trackedChanges" || !tr.docChanged) return undefined
	if (mode === "comments" && session.story.story.kind === "comment") return undefined

	const index = permissionRanges(session)
	let ranges: readonly number[] = state.doc === tr.before ? index.of(tr.before) : []
	const part = session.story.part

	for (let k = 0; k < tr.steps.length; k++) {
		const step = tr.steps[k] as Step
		const doc = tr.docs[k] as Node
		const touched = stepRanges(step, doc)

		if (touched === undefined) return "protected"

		for (let r = 0; r < touched.length; r += 2) {
			const from = touched[r] ?? 0
			const to = touched[r + 1] ?? 0

			if (index.covers(doc, from, to, ranges)) continue
			if (
				mode === "forms" &&
				(form || !directFormatting(step)) &&
				(controlStateStep(step, doc) || formFillable(part, doc, from, to, form, step) || swapsPicture(part, doc, step))
			)
				continue

			return "protected"
		}

		const map = tr.mapping.maps[k]

		if (map !== undefined && ranges.length > 0) ranges = ranges.map((pos, n) => map.map(pos, n % 2 === 0 ? -1 : 1))
	}

	return undefined
}

// Why a session's own transaction (one the transformers do not see: a review resolution, a section or field
// change, a bookmark) edits outside what the protection allows, or undefined. Comments and the markers anchoring
// them are what comments protection allows; values bound controls show (forms/sync.ts) follow their node.
export function internalViolation(tr: Transaction, session: DocxEditorSession): string | undefined {
	const mode = protectionOf(session.context).mode

	if (mode === "none" || mode === "trackedChanges" || !tr.docChanged || exempt.has(tr)) return undefined
	if (mode === "comments" && tr.steps.every((step, k) => anchorsComment(step, tr.docs[k] as Node))) return undefined

	return protectionViolation(tr, session, false, session.state)
}

const exempt = new WeakSet<Transaction>()

// A transaction protection lets through as it is (a bound value shown in the controls of its node).
export function exemptFromProtection(tr: Transaction): Transaction {
	exempt.add(tr)

	return tr
}

// A step that only inserts or removes comment anchors, or sets the document's comments.
const COMMENT_MARKERS: ReadonlySet<string> = new Set(["commentRangeStart", "commentRangeEnd", "commentReference"])

// A comment's anchor: its range markers and its reference (not a bookmark's or a permission's marker).
function commentAnchor(node: Node): boolean {
	return (
		node.type === docxSchema.nodes.comment_ref ||
		(node.type === docxSchema.nodes.marker && COMMENT_MARKERS.has(node.attrs["kind"] as string))
	)
}

// Whether a block's marker list changes only by comment markers.
function commentMarkersOnly(before: MarkerList | undefined, after: MarkerList | undefined): boolean {
	const other = (list: MarkerList | undefined): string =>
		(list ?? [])
			.filter(marker => !COMMENT_MARKERS.has(marker.kind))
			.map(marker => `${marker.kind}|${String(marker.src)}|${String(marker.id)}`)
			.join(",")

	return other(before) === other(after)
}

function anchorsComment(step: Step, doc: Node): boolean {
	if (step instanceof DocAttrStep)
		return (
			step.attr === "comments" ||
			(step.attr === "end" && commentMarkersOnly(doc.attrs["end"] as MarkerList | undefined, step.value as MarkerList | undefined))
		)
	if (step instanceof AttrStep) {
		const node = doc.nodeAt(step.pos)

		return (
			node !== null &&
			(step.attr === "before" || step.attr === "end") &&
			commentMarkersOnly(node.attrs[step.attr] as MarkerList | undefined, step.value as MarkerList | undefined)
		)
	}
	if (!(step instanceof ReplaceStep)) return false

	let only = true

	step.slice.content.forEach(node => {
		if (!commentAnchor(node)) only = false
	})
	if (step.to > step.from)
		doc.nodesBetween(step.from, step.to, node => {
			if (node.isInline && !commentAnchor(node)) only = false

			return only && !node.isInline
		})

	return only
}

// Formatting set on content (not a revision a recording adds, nor a control): what Word's forms protection lets
// no one change, inside a control too (format commands are refused there).
function directFormatting(step: Step): boolean {
	return (
		markStepsOf(step)?.some(part =>
			markStepTypes(part).some(type => type.name !== "content_control" && !REVISION_MARKS.has(type.name))
		) ?? false
	)
}

const REVISION_MARKS = new Set(["insertion", "deletion", "move_from", "move_to", "format_change"])

// A picture control's picture replaced (Word lets a form's user change it).
function swapsPicture(part: StoryPart, doc: Node, step: Step): boolean {
	return step instanceof ReplaceStep && pictureSwap(part, doc, step.from, step.to, step.slice.content)
}

// Whether [from, to] lies inside a content control a user may type into (`form`: one a form command changes,
// whose content is not locked). Paragraphs a step brings into a run-level control would split the protected
// paragraph holding it.
function formFillable(part: StoryPart, doc: Node, from: number, to: number, form: boolean, step: Step): boolean {
	const around = controlAround(part, doc, from, to)
	const blocker = around === undefined ? "none" : typeable(around.info)

	if (around?.kind === "inline" && (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) && splits(step)) return false

	return blocker === undefined || (form && blocker === "notText")
}

function splits(step: ReplaceStep | ReplaceAroundStep): boolean {
	if (step.slice.openStart > 0 || step.slice.openEnd > 0) return true

	let block = false

	step.slice.content.forEach(node => {
		if (node.isBlock) block = true
	})

	return block
}
