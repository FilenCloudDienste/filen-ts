import { Fragment, Slice, type Mark, type Node } from "prosemirror-model"
import { TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import { closeHistory } from "prosemirror-history"
import {
	MAX_LINK_TARGET,
	MAX_LINK_TEXT,
	insertable as insertableText,
	linkTargetRefusal,
	linkTargetUri,
	type InsertCommand
} from "../commands/insert"
import { commandAllowed } from "../protection"
import type { DocxEditorSession } from "../session"
import { headingBookmark } from "../../fields/bookmarks"
import type { DocxEditContext } from "../context"
import { builtInStyleId, caretMarks, changeMarks, knownBuiltInStyleId, runPiecesIn, type FormatResolver } from "../formats"
import type { FeatureHandlers, StoryCommandContext, StoryCommandHandler } from "../registry"
import type { ParagraphBordersProps } from "../../props/index"
import { NO_SOURCE, docxSchema } from "../schema"
import { Ns } from "../../model/namespaces"
import { openDocumentTranslation } from "../../layout/geometry"
import { selectedLink, selectionHasLink } from "../snapshot/formats"

// Links, breaks and characters from a symbol picker.

const marks = docxSchema.marks
const nodes = docxSchema.nodes
// What a symbol picker's text becomes besides text: Word's nonbreaking and optional hyphens, and tabs.
const SPECIAL = /([\u2011\u00ad\t])/

type Cmd<T extends InsertCommand["type"]> = Extract<InsertCommand, { readonly type: T }>

function inParagraph(state: EditorState): boolean {
	const { $from, $to } = state.selection

	return $from.parent.type === nodes.paragraph && $to.parent.type === nodes.paragraph
}

function insertable(context: StoryCommandContext): boolean {
	return !context.session.readOnly && inParagraph(context.state)
}

function inCell(state: EditorState): boolean {
	for (const $pos of [state.selection.$from, state.selection.$to]) {
		for (let depth = $pos.depth; depth > 0; depth--) if ($pos.node(depth).type === nodes.table_cell) return true
	}

	return false
}

// The caret's marks (what typing there gets), or those the whole selection shares.
function marksAt(state: EditorState, formats: FormatResolver): readonly Mark[] {
	const { $from, $to, empty } = state.selection

	return empty ? caretMarks(state, formats) : ($from.marksAcross($to) ?? $from.marks())
}

// ---- breaks and characters -----------------------------------------------------------------------------

// Word's Ctrl+Enter: a page break, and the text after it in a paragraph of its own on the next page.
function pageBreak(context: StoryCommandContext): Transaction | null {
	const tr = context.state.tr.replaceSelectionWith(nodes.break.create({ type: "page" }), true)

	return tr.split(tr.selection.from).scrollIntoView()
}

function lineBreak(context: StoryCommandContext): Transaction | null {
	return context.state.tr.replaceSelectionWith(nodes.break.create({ type: "textWrapping" }), true).scrollIntoView()
}

// The border Word's AutoFormat gives a "---" paragraph: a single line of 3/4 point, 1 point below the text.
const LINE_BORDERS: ParagraphBordersProps = Object.freeze({ bottom: Object.freeze({ style: "single", size: 6, space: 1, val: "auto" }) })

// A horizontal line after the selection's paragraph (or on it, when it is empty), the caret in a new paragraph
// after the line, as Word leaves it after AutoFormat.
function horizontalLine(context: StoryCommandContext): Transaction | null {
	const state = context.state
	const $to = state.selection.$to
	const paragraph = $to.parent
	const after = $to.after()
	const styleId = paragraph.attrs["styleId"] as string | null
	const next = nodes.paragraph.create({ styleId })
	const tr = state.tr
	let caret: number

	if (paragraph.content.size === 0) {
		tr.setNodeAttribute($to.before(), "borders", LINE_BORDERS)
		tr.insert(after, next)
		caret = after + 1
	} else {
		const line = nodes.paragraph.create({ styleId, borders: LINE_BORDERS })

		tr.insert(after, [line, next])
		caret = after + line.nodeSize + 1
	}

	return tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView()
}

function symbol(context: StoryCommandContext, command: Cmd<"insert.symbol">): Transaction | null {
	const state = context.state
	const marksOf = marksAt(state, context.session.formats)
	const content: Node[] = []

	for (const part of command.text.split(SPECIAL)) {
		if (part === "") continue

		const node =
			part === "\u2011" || part === "\u00ad"
				? nodes.hyphen.create({ soft: part === "\u00ad" }, null, marksOf)
				: part === "\t"
					? nodes.tab.create(null, null, marksOf)
					: docxSchema.text(part, marksOf)

		content.push(node)
	}

	return state.tr.replaceSelection(new Slice(Fragment.fromArray(content), 0, 0)).scrollIntoView()
}

// ---- links ---------------------------------------------------------------------------------------------

const HYPERLINK_STYLE = "Hyperlink"

// The formatting a new link gets: the Hyperlink character style, added when the document lacks it (as Word). A
// document translated from OpenDocument gets no style it lacks: its own Hyperlink style, else the look of one.
function linkFormatting(context: DocxEditContext): readonly Mark[] {
	if (!openDocumentTranslation(context.model.settings)) {
		return [marks.char_style.create({ styleId: builtInStyleId(context, HYPERLINK_STYLE) })]
	}

	const style = knownBuiltInStyleId(context, HYPERLINK_STYLE)

	if (style !== undefined) return [marks.char_style.create({ styleId: style })]

	return [
		marks.color.create({ value: context.resolver.color({ themeColor: "hyperlink" }) ?? "0563C1", themeColor: "hyperlink" }),
		marks.underline.create({ style: "single" })
	]
}

// Whether `mark` is formatting a link got for being one (see linkFormatting; a direct theme colour and underline
// is how other producers format one).
function isLinkFormatting(context: DocxEditContext, mark: Mark): boolean {
	switch (mark.type) {
		case marks.char_style: {
			const id = knownBuiltInStyleId(context, HYPERLINK_STYLE)

			return id !== undefined && mark.attrs["styleId"] === id
		}
		case marks.color:
			return mark.attrs["themeColor"] === "hyperlink"
		default:
			return false
	}
}

// The attributes of a link to `target` and `anchor` that replaces `existing`: a link from the file keeps what
// it says besides them (w:tooltip, w:tgtFrame, w:history, w:docLocation), written anew around its content.
function linkAttrs(
	context: StoryCommandContext,
	existing: Mark | undefined,
	target: string | null,
	anchor: string | null
): Record<string, unknown> {
	const own = (existing?.attrs["src"] as number | undefined) ?? NO_SOURCE

	if (existing === undefined || own === NO_SOURCE)
		return { target, anchor, tooltip: (existing?.attrs["tooltip"] as string | null | undefined) ?? null }

	const part = context.session.story.part
	const source = part.hyperlink(own)

	return {
		target,
		anchor,
		tooltip: source.tooltip ?? null,
		targetFrame: source.targetFrame ?? null,
		history: part.reader.attr(part.node(own), Ns.W, "history") ?? null,
		docLocation: source.docLocation ?? null
	}
}

// A heading's text as a link to it shows it: its first line, as much as a link's text holds.
function headingText(doc: Node, pos: number): string | undefined {
	const text = doc.nodeAt(pos)?.textContent.split("\n")[0]?.trim().slice(0, MAX_LINK_TEXT) ?? ""

	return text === "" || !insertableText(text) ? undefined : text
}

// Content marks after a link without the link and the look it got for being one: what is typed after a link
// the caret leaves.
function withoutLink(context: DocxEditContext, marksOf: readonly Mark[]): readonly Mark[] {
	// The underline went with a link's colour (see linkFormatting).
	const colored = marksOf.some(mark => mark.type === marks.color && isLinkFormatting(context, mark))

	return marksOf.filter(
		mark => mark.type !== marks.link && !isLinkFormatting(context, mark) && !(colored && mark.type === marks.underline)
	)
}

// [from, to] becomes `link`; `fresh`: a new link, which gets the formatting of one (see linkFormatting).
function markLink(tr: Transaction, context: DocxEditContext, from: number, to: number, link: Mark, fresh: boolean): void {
	tr.removeMark(from, to, marks.link)
	tr.addMark(from, to, link)

	if (!fresh) return

	const pieces = runPiecesIn(tr.doc, [{ from, to }])

	for (const mark of linkFormatting(context)) changeMarks(tr, pieces, mark.type, () => mark)
}

// link.set: the link at the selection gets the new target (and text); else the selection becomes a link, or
// the text (by default the target, or the heading linked to) is inserted as one at the caret. A link to a
// heading goes to its hidden bookmark, made in the same step when it has none (one undo takes both).
function setLink(context: StoryCommandContext, command: Cmd<"link.set">): Transaction | true | null {
	const state = context.state
	const selection = state.selection
	const existing = selectedLink(state)
	const tr = state.tr
	// The file holds a URI reference: what one does not allow is encoded, as the bridge's parser does.
	const written = "target" in command ? linkTargetUri(command.target) : null

	if (
		written !== null &&
		("refusal" in written || linkTargetRefusal(written.uri, existing?.link.attrs["target"] as string | null) !== undefined)
	)
		return null

	const target = written === null ? null : written.uri
	const anchor =
		"anchor" in command ? command.anchor : "heading" in command ? headingBookmark(tr, context.session, command.heading) : null

	if (anchor === undefined) return null

	const heading = "heading" in command ? headingText(state.doc, command.heading) : undefined

	// A link to a heading without text shows nothing to click: one is made of a selection or a given text.
	if ("heading" in command && heading === undefined && command.text === undefined && existing === undefined && selection.empty)
		return null
	const link = marks.link.create(linkAttrs(context, existing?.link, target, anchor))
	let from = tr.mapping.map(existing?.from ?? selection.from, -1)
	let to = tr.mapping.map(existing?.to ?? selection.to, 1)
	const before = marksAt(state, context.session.formats)

	if (existing === undefined && selection.empty) {
		const text = command.text ?? heading ?? target ?? anchor ?? ""

		tr.insert(from, docxSchema.text(text, marks.link.removeFromSet(before)))
		to = from + text.length
	} else if (
		command.text !== undefined &&
		tr.doc.resolve(from).parent === tr.doc.resolve(to).parent &&
		tr.doc.textBetween(from, to) !== command.text
	) {
		const first = runPiecesIn(tr.doc, [{ from, to }])[0]?.node.marks ?? tr.doc.resolve(from).marks()

		tr.replaceWith(from, to, docxSchema.text(command.text, first))
		from = tr.mapping.map(from, -1)
		to = from + command.text.length
	}

	// The same target and text: nothing to do (a link from the file stays its element).
	if (existing !== undefined && existing.link.attrs["target"] === target && existing.link.attrs["anchor"] === anchor && !tr.docChanged)
		return true

	markLink(tr, context.context, from, to, link, existing === undefined)

	if (selection.empty) {
		tr.setSelection(TextSelection.create(tr.doc, to))
		// What is typed next is no part of the link and does not look like one (as in Word).
		tr.setStoredMarks(
			existing === undefined ? marks.link.removeFromSet(before) : withoutLink(context.context, tr.doc.resolve(to).marks())
		)
	}

	return tr.scrollIntoView()
}

// link.remove: the link at the caret goes whole; with a selection, the links in it. The formatting the links
// got for being links goes with them.
function removeLink(context: StoryCommandContext): Transaction | null {
	const state = context.state
	const existing = selectedLink(state)
	const from = existing?.from ?? state.selection.from
	const to = existing?.to ?? state.selection.to

	if (to <= from) return null

	const tr = state.tr.removeMark(from, to, marks.link)
	const pieces = runPiecesIn(tr.doc, [{ from, to }])
	const ofLink = (piece: { readonly node: Node }, type: typeof marks.color): boolean =>
		piece.node.marks.some(mark => mark.type === type && isLinkFormatting(context.context, mark))

	changeMarks(tr, pieces, marks.char_style, piece =>
		ofLink(piece, marks.char_style) ? undefined : marks.char_style.isInSet(piece.node.marks)
	)

	// Recomputed: the char_style steps changed the nodes.
	const after = runPiecesIn(tr.doc, [{ from, to }])

	changeMarks(tr, after, marks.underline, piece => (ofLink(piece, marks.color) ? undefined : marks.underline.isInSet(piece.node.marks)))
	changeMarks(tr, after, marks.color, piece => (ofLink(piece, marks.color) ? undefined : marks.color.isInSet(piece.node.marks)))

	return tr.docChanged ? tr : null
}

// ---- links as you type ---------------------------------------------------------------------------------

// Word's AutoFormat As You Type, "Internet and network paths with hyperlinks": a web or e-mail address the
// caret leaves with Space, Tab or Enter becomes a link.

const SPACE = /\s/
// Around an address: quotes and brackets before it, sentence punctuation after it.
const LEADING = new Set(["(", "<", '"', "'", "“", "‘"])
const TRAILING = new Set([".", ",", ";", ":", "!", "?", '"', "'", ">", "”", "’"])
const WEB = /^(?:https?:\/\/[^/?#]+|www\.[^/?#.]+(?:\.[^/?#.]+)+(?=[/?#]|$))/i
const EMAIL = /^(?:mailto:)?[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u
// What a link cannot be made of: text already linked, or deleted.
const UNLINKABLE = [marks.link, marks.deletion, marks.move_from]

// The word that ends at `pos` in its paragraph ([from, pos)): the text since the last space, tab or break.
// Undefined when it is empty or too long to be an address, or when another inline node (a field, a bookmark,
// a picture) or linked or deleted text is part of it.
function wordBefore(doc: Node, pos: number): { readonly from: number; readonly text: string } | undefined {
	const $pos = doc.resolve(pos)
	const parent = $pos.parent

	if (parent.type !== nodes.paragraph) return undefined

	let index = $pos.textOffset > 0 ? $pos.index() : $pos.index() - 1
	let cut = $pos.textOffset
	let text = ""

	for (; index >= 0; index--) {
		const child = parent.child(index)

		if (!child.isText) {
			if (child.type === nodes.tab || child.type === nodes.break) break

			return undefined
		}

		const own = cut > 0 ? (child.text ?? "").slice(0, cut) : (child.text ?? "")
		let start = own.length

		cut = 0

		while (start > 0 && !SPACE.test(own[start - 1] ?? "")) {
			if (own.length - start + text.length >= MAX_LINK_TARGET) return undefined

			start--
		}

		if (start < own.length) {
			if (child.marks.some(mark => UNLINKABLE.includes(mark.type))) return undefined

			text = own.slice(start) + text
		}

		if (start > 0) break
	}

	return text === "" ? undefined : { from: pos - text.length, text }
}

// The address `word` holds and where in it ([start, end)), punctuation around it left out; undefined when it
// holds none. www. goes to http://, a bare e-mail address to mailto:.
function addressIn(word: string): { readonly start: number; readonly end: number; readonly target: string } | undefined {
	let start = 0
	let end = word.length

	while (start < end && LEADING.has(word[start] ?? "")) start++

	for (;;) {
		const last = word[end - 1] ?? ""

		if (end > start && (TRAILING.has(last) || (last === ")" && unbalanced(word, start, end)))) end--
		else break
	}

	const address = word.slice(start, end)

	if (WEB.test(address)) return { start, end, target: /^www\./i.test(address) ? `http://${address}` : address }
	if (EMAIL.test(address)) return { start, end, target: /^mailto:/i.test(address) ? address : `mailto:${address}` }

	return undefined
}

// Whether word[start, end) closes more brackets than it opens.
function unbalanced(word: string, start: number, end: number): boolean {
	let depth = 0

	for (let k = start; k < end; k++) {
		if (word[k] === "(") depth++
		else if (word[k] === ")") depth--
	}

	return depth < 0
}

// Whether `pos` lies in a field's code or result (between a field character begin and its end).
function inField(doc: Node, pos: number): boolean {
	let depth = 0

	doc.nodesBetween(0, pos, (node, at) => {
		if (node.type === nodes.field_char && at < pos) {
			const kind = node.attrs["kind"] as string

			if (kind === "begin") depth++
			else if (kind === "end") depth = Math.max(0, depth - 1)
		}

		return !node.isLeaf
	})

	return depth > 0
}

// The link the address ending at `pos` (the caret before the key that ends it) becomes, as its own undo step
// (one undo right after the key takes back only the link, as in Word); null when the word there is no address,
// is linked already, or may not be edited.
export function autoLink(session: DocxEditorSession, pos: number): Transaction | null {
	const state = session.state

	if (session.readOnly) return null

	const word = wordBefore(state.doc, pos)
	const address = word === undefined ? undefined : addressIn(word.text)

	if (word === undefined || address === undefined) return null

	const written = linkTargetUri(address.target)

	if ("refusal" in written || linkTargetRefusal(written.uri) !== undefined) return null

	const from = word.from + address.start
	const to = word.from + address.end

	if (!commandAllowed(session, "link.set") || inField(state.doc, from)) return null

	const context: StoryCommandContext = { session, state, context: session.context }
	const tr = state.tr

	markLink(tr, session.context, from, to, marks.link.create(linkAttrs(context, undefined, written.uri, null)), true)

	// What is typed next keeps the formatting it was to have.
	if (state.storedMarks !== null) tr.setStoredMarks(state.storedMarks)

	return closeHistory(tr)
}

// ---- handlers ------------------------------------------------------------------------------------------

function handler<T extends InsertCommand["type"]>(
	run: (context: StoryCommandContext, command: Cmd<T>) => Transaction | true | null,
	enabled: (context: StoryCommandContext) => boolean = insertable
): StoryCommandHandler<T> {
	return { enabled, run: (context, command) => run(context, command as Cmd<T>) }
}

export const INSERT_HANDLERS: FeatureHandlers = {
	story: {
		"link.set": handler(setLink),
		"link.remove": handler(removeLink, context => insertable(context) && selectionHasLink(context.session, context.state)),
		// Only the body breaks pages, and not inside a table.
		"insert.pageBreak": handler(
			pageBreak,
			context => insertable(context) && context.session.story.story.kind === "body" && !inCell(context.state)
		),
		"insert.lineBreak": handler(lineBreak),
		"insert.horizontalLine": handler(horizontalLine, insertable),
		"insert.symbol": handler(symbol)
	}
}
