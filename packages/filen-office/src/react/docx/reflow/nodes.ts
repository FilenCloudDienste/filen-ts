import type { Mark, Node } from "prosemirror-model"
import type { Decoration, EditorView, MarkViewConstructor, NodeView, NodeViewConstructor } from "prosemirror-view"
import { BLOCK_NODE_MARKS, docxSchema, equationTree } from "../../../core/docx/edit/index"
import type { OmmlRevisionView } from "../../../core/math/index"
import { ObjectKind, textboxStories } from "../../../core/docx/layout/objects"
import { RevisionFlag } from "../../../core/docx/model/kinds"
import { drawingEdit, drawingState, isNewPicture, sourceDrawing } from "../../../core/docx/objects/edit"
import type { PagedEditor } from "../../../core/docx/paged/index"
import type { ObjectHitKind } from "../../../core/docx/paged/objects"
import type { CssFaces } from "../../../core/docx/reflow/css"
import { docxNotes } from "../../../core/docx/stories/notes"
import { symbolTable, symbolToUnicode } from "../../../core/fonts/index"
import { attrText, fieldText } from "../edit/clipboard"
import { EMU_PER_PAGE_PX } from "../edit/objects"
import { gapRowCount, isGap } from "../edit/window"
import { paintMath } from "../paint/math"
import { paintObjects } from "../paint/objects"
import type { DocxDocument } from "../store"
import { paragraphStyle, type ReflowSource } from "./decorate"

// The reflowed view's nodes: paragraphs and runs styled from their resolved properties, tables as HTML tables
// that scroll sideways, pictures and equations painted as on the pages and scaled to the width, text boxes and
// notes as nested editing views of their stories, gaps (blocks not held) as empty boxes of the blocks' height.

// A story shown in a node: `release` takes it down, `relabel` names it again (its mark changed).
export interface NestedStory {
	readonly release: () => void
	readonly relabel: () => void
}

// What the nodes need of the view that holds them.
export interface ReflowNodeHost {
	readonly editor: PagedEditor
	// The renderer's side of the document (media, painted objects).
	readonly document: DocxDocument
	readonly faces: CssFaces
	readonly facesVersion: number
	// How equations show tracked changes (the revision view, authors' colours).
	readonly equationView: OmmlRevisionView
	// Shows story `story` (a note, a text box) in `mount`, editable as the rest, its reference at `at` (`mark` a
	// note's mark as shown, for its name).
	nest(story: number, mount: HTMLElement, at: () => number | undefined, mark?: () => string): NestedStory
	// `refresh` is called when the faces the document's fonts draw with, or the revision view, change; the returned
	// function stops that.
	live(refresh: () => void): () => void
	// A press on `element` hits an object of `kind` at the position `getPos` gives (in `session`'s story).
	target(element: HTMLElement, kind: ObjectHitKind, session: ReflowSource, getPos: () => number | undefined): void
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
	const made = document.createElement(tag)

	if (className !== undefined) made.className = className

	return made
}

function symbolChar(node: Node): string {
	const char = node.attrs["char"]
	const font = node.attrs["font"]

	if (typeof char !== "number" || char <= 0 || char > 0x10ffff) return ""

	// A symbol font's code (Symbol, Wingdings...): the Unicode character it shows.
	const table = typeof font === "string" ? symbolTable(font) : undefined
	const mapped = table === undefined ? 0 : symbolToUnicode(table, char)

	return String.fromCodePoint(mapped > 0 ? mapped : char)
}

// An inline leaf showing `text` (no caret inside).
function leaf(text: (node: Node) => string, className: string, tag: "span" | "br" = "span"): NodeViewConstructor {
	return node => {
		const dom = element(tag, className)

		if (tag === "span") dom.textContent = text(node)

		dom.contentEditable = "false"

		return { dom, ignoreMutation: () => true }
	}
}

const none = (): string => ""

// A note reference's mark as numbered: what the decoration drawing it carries ("" for a custom mark).
function noteMark(decorations: readonly Decoration[]): string {
	for (const decoration of decorations) {
		const spec: unknown = decoration.spec

		if (typeof spec === "object" && spec !== null && "note" in spec && typeof spec.note === "string") return spec.note
	}

	return ""
}

export function reflowNodeViews(host: ReflowNodeHost, session: ReflowSource): Record<string, NodeViewConstructor> {
	const editor = host.editor
	const part = session.story.part
	return {
		paragraph: node => {
			if (isGap(node)) {
				const dom = element("div", "fo-docx-reflow-gap")

				dom.contentEditable = "false"

				return { dom, update: (next: Node) => isGap(next), ignoreMutation: () => true } satisfies NodeView
			}

			const dom = element("p", "fo-docx-reflow-p")
			let shown = node
			const restyle = (): void => {
				const { css, cases } = paragraphStyle(session, shown, host.faces)

				if (dom.getAttribute("style") !== css) dom.setAttribute("style", css)
				// Cased text in the neutral language the pages measured it in (casesText).
				if (cases !== dom.hasAttribute("lang")) {
					if (cases) dom.setAttribute("lang", "")
					else dom.removeAttribute("lang")
				}
			}
			const stop = host.live(restyle)

			restyle()

			return {
				dom,
				contentDOM: dom,
				update(next: Node) {
					if (next.type !== node.type || isGap(next)) return false

					const changed = next.attrs !== shown.attrs

					shown = next

					if (changed) restyle()

					return true
				},
				// Its look is the view's own write (outside an update when the faces change): never content to read.
				ignoreMutation: mutation => mutation.type === "attributes" && mutation.target === dom,
				destroy: stop
			} satisfies NodeView
		},
		table: node => {
			// The table scrolls sideways in a box of the view's width.
			const dom = element("div", "fo-docx-reflow-table")
			const table = element("table")
			const columns = element("colgroup")
			const body = element("tbody")
			const grid = (next: Node): void => {
				const widths = Array.isArray(next.attrs["grid"]) ? (next.attrs["grid"] as unknown[]) : []
				let total = 0

				columns.replaceChildren(
					...widths.map(width => {
						const column = element("col")

						if (typeof width === "number" && width > 0) {
							column.style.width = `${String(Math.round(width / 15))}px`
							total += Math.round(width / 15)
						}

						return column
					})
				)
				// Fixed layout from the grid: a row's cells take the grid's widths, whatever rows the view holds.
				table.style.width = total > 0 ? `${String(total)}px` : ""
			}
			let shown = node.attrs["grid"]

			grid(node)
			table.append(columns, body)
			dom.appendChild(table)

			return {
				dom,
				contentDOM: body,
				update(next: Node) {
					if (next.type !== node.type) return false

					if (next.attrs["grid"] !== shown) {
						shown = next.attrs["grid"]
						grid(next)
					}

					return true
				},
				ignoreMutation: mutation => mutation.type !== "selection" && !body.contains(mutation.target)
			} satisfies NodeView
		},
		table_row: node => {
			// Rows of a long table the view does not hold: one empty row of their height.
			if (gapRowCount(node) !== undefined) {
				const dom = element("tr", "fo-docx-reflow-gap-row")
				const cell = element("td")

				cell.colSpan = 1000
				dom.appendChild(cell)
				dom.contentEditable = "false"

				return { dom, update: (next: Node) => gapRowCount(next) !== undefined, ignoreMutation: () => true }
			}

			const dom = element("tr")

			revise(dom, node)

			return {
				dom,
				contentDOM: dom,
				update: (next: Node) => {
					if (next.type !== node.type || gapRowCount(next) !== undefined) return false

					revise(dom, next)

					return true
				}
			}
		},
		table_cell: node => {
			const dom = element("td")
			const span = node.attrs["colspan"]

			if (typeof span === "number" && span > 1) dom.colSpan = span
			// A vertically merged cell's continuation: one cell with the one above, as Word draws it.
			if (node.attrs["vMerge"] === "continue") dom.dataset["foMerged"] = ""

			revise(dom, node)

			return {
				dom,
				contentDOM: dom,
				update: (next: Node) => {
					if (next.type !== node.type || next.attrs["colspan"] !== node.attrs["colspan"]) return false

					revise(dom, next)

					return true
				}
			}
		},
		sdt: () => {
			const dom = element("div", "fo-docx-reflow-sdt")

			return { dom, contentDOM: dom }
		},
		locked_block: node => {
			const dom = element("div", "fo-docx-reflow-locked")

			dom.contentEditable = "false"
			dom.textContent = attrText("text")(node)

			return { dom, ignoreMutation: () => true }
		},
		tab: leaf(() => "\t", "fo-docx-reflow-tab"),
		break: node => {
			const type = node.attrs["type"]

			// Page and column breaks: a rule across the width (there are no pages here).
			if (type === "page" || type === "column") {
				const dom = element("span", "fo-docx-reflow-break")

				dom.contentEditable = "false"
				dom.dataset["foBreak"] = type

				return { dom, ignoreMutation: () => true }
			}

			return { dom: element("br"), ignoreMutation: () => true }
		},
		hyphen: leaf(node => (node.attrs["soft"] === true ? "­" : "‑"), "fo-docx-reflow-hyphen"),
		symbol: leaf(symbolChar, "fo-docx-reflow-symbol"),
		note_ref: (node, _view, getPos, decorations) => {
			const dom = element("span", "fo-docx-reflow-note-ref")
			const kind = node.attrs["kind"] === "endnote" ? "endnote" : "footnote"
			const id = node.attrs["id"]
			const story = typeof id === "string" ? docxNotes(editor).storyOf(kind, id) : undefined
			const body = element("span", "fo-docx-reflow-note")
			// The mark as numbered (the decoration that draws it), for the note's name.
			let mark = noteMark(decorations)
			const nested = story === undefined ? undefined : host.nest(story.index, body, getPos, () => mark)

			dom.contentEditable = "false"
			dom.dataset["foKind"] = kind
			dom.appendChild(body)
			host.target(dom, "noteRef", session, getPos)

			return {
				dom,
				update: (next: Node, outer: readonly Decoration[]) => {
					if (next.type !== node.type || next.attrs["kind"] !== node.attrs["kind"] || next.attrs["id"] !== id) return false

					const now = noteMark(outer)

					if (now !== mark) {
						mark = now
						nested?.relabel()
					}

					return true
				},
				// The note's own view takes its events and changes.
				stopEvent: event => event.target instanceof globalThis.Node && body.contains(event.target),
				ignoreMutation: () => true,
				destroy: () => nested?.release()
			}
		},
		comment_ref: node => {
			const dom = element("span", "fo-docx-reflow-comment-ref")
			const id = node.attrs["id"]

			dom.contentEditable = "false"

			if (typeof id === "string") dom.dataset["foComment"] = id

			return { dom, ignoreMutation: () => true }
		},
		drawing: (node, _view, getPos) => drawingView(host, session, node, getPos),
		math: (node, _view, getPos) => {
			const dom = element(
				"span",
				node.attrs["display"] === true ? "fo-docx-reflow-math fo-docx-reflow-display" : "fo-docx-reflow-math"
			)
			// From its OMML, as the pages paint it (a new equation too) in the revision view shown; the layout's
			// object when it has none.
			let release: () => void = () => undefined
			const paint = (): void => {
				const tree = equationTree(node, part, host.equationView)

				release()
				dom.replaceChildren()
				dom.classList.remove("fo-docx-placeholder")
				release = () => undefined

				if (tree === null) release = paintObject(host, dom, editor.layout.objects.idOf(part.index, node.attrs["src"] as number))
				else {
					try {
						dom.appendChild(paintMath(tree, dom.ownerDocument))
					} catch {
						dom.classList.add("fo-docx-placeholder")
					}
				}
			}
			const stop = host.live(paint)

			paint()
			dom.contentEditable = "false"
			host.target(dom, "equation", session, getPos)

			return {
				dom,
				update: (next: Node) => next === node,
				ignoreMutation: () => true,
				destroy() {
					stop()
					release()
				}
			}
		},
		run_object: leaf(attrText("text"), "fo-docx-reflow-object"),
		// What it shows (fieldText), or its code in braces while it shows that (a data-fo-code decoration, as the
		// pages show it).
		field: (node, _view, getPos) => {
			const dom = element("span", "fo-docx-reflow-field")
			const result = element("span", "fo-docx-reflow-result")

			result.textContent = fieldText(node)
			dom.appendChild(result)
			dom.contentEditable = "false"
			host.target(dom, "field", session, getPos)

			return { dom, ignoreMutation: () => true }
		},
		field_char: leaf(none, "fo-docx-reflow-field-char"),
		marker: leaf(none, "fo-docx-reflow-empty"),
		proof_err: leaf(none, "fo-docx-reflow-empty"),
		rendered_break: leaf(none, "fo-docx-reflow-empty"),
		opaque_inline: leaf(attrText("text"), "fo-docx-reflow-object")
	}
}

// Paints the layout's object `id` (a picture, a shape, an equation) into `dom`; the returned function releases
// its images. A placeholder box when the layout has not seen it.
function paintObject(host: ReflowNodeHost, dom: HTMLElement, id: number): () => void {
	const objects = host.editor.layout.objects
	const { session, media } = host.document

	if (id < 0 || session === undefined || media === undefined) {
		dom.classList.add("fo-docx-placeholder")

		return () => undefined
	}

	const signal = { aborted: false }
	const release = paintObjects(
		[
			{
				element: dom,
				id,
				kind: objects.kinds[id] ?? ObjectKind.DRAWING,
				width: objects.widths[id] ?? 0,
				height: objects.heights[id] ?? 0
			}
		],
		{ document: dom.ownerDocument, session, media, signal }
	)

	return () => {
		signal.aborted = true
		release()
	}
}

// A picture or shape at the width it has, never wider than the view (scaled down keeping its proportions); a
// text box's stories as nested views; a picture inserted since the document opened from its bytes.
function drawingView(host: ReflowNodeHost, session: ReflowSource, node: Node, getPos: () => number | undefined): NodeView {
	const editor = host.editor
	const dom = element("span", "fo-docx-reflow-drawing")
	const context = session.context
	const state = drawingState(context, node)
	const objects = editor.layout.objects
	const id = isNewPicture(node) ? -1 : objects.idOf(session.story.part.index, node.attrs["src"] as number)
	const width = state.cx > 0 ? state.cx / EMU_PER_PAGE_PX : (objects.widths[id] ?? 0)
	const height = state.cy > 0 ? state.cy / EMU_PER_PAGE_PX : (objects.heights[id] ?? 0)
	// Its text boxes' stories, from the document (whether or not the layout has seen the drawing).
	const source = sourceDrawing(context, node)
	const sourcePart = source === undefined || source.textboxes === 0 ? undefined : editor.edits.model.parts[source.part]
	const stories =
		(source === undefined || sourcePart === undefined ? undefined : textboxStories(editor.edits.model, sourcePart, source.item)) ??
		(id < 0 ? undefined : objects.textboxes[id])
	const cleanups: (() => void)[] = []

	dom.contentEditable = "false"

	// Hidden (wp:docPr hidden): not shown, as on the pages.
	if (source?.hidden === true) {
		dom.hidden = true

		return { dom, update: (next: Node) => next === node, ignoreMutation: () => true }
	}

	if (node.attrs["anchored"] === true) dom.dataset["foAnchored"] = ""

	if (stories !== undefined && stories.length > 0) {
		// A text box: its text, not its shape.
		dom.classList.add("fo-docx-reflow-textbox")

		for (const story of stories) {
			const mount = element("span", "fo-docx-reflow-textbox-story")

			dom.appendChild(mount)
			cleanups.push(host.nest(story, mount, getPos).release)
		}
	} else {
		if (width > 0 && height > 0) {
			dom.style.width = `${String(Math.round(width))}px`
			dom.style.aspectRatio = `${String(Math.round(width))} / ${String(Math.round(height))}`
		}

		const handle = drawingEdit(node)?.media
		const entry = isNewPicture(node) && handle !== undefined ? context.media.get(handle) : undefined
		const media = host.document.media

		if (entry !== undefined && media !== undefined) {
			const url = media.createBytesUrl(entry.bytes, entry.info.contentType ?? "")

			if (url === undefined) dom.classList.add("fo-docx-placeholder")
			else {
				const image = element("img")

				image.src = url
				image.alt = state.descr
				image.draggable = false
				dom.appendChild(image)
				cleanups.push(() => media.revokeBytesUrl(url))
			}
		} else {
			cleanups.push(paintObject(host, dom, id))
		}

		if (state.descr.length > 0) dom.setAttribute("aria-label", state.descr)
	}

	host.target(dom, "drawing", session, getPos)

	return {
		dom,
		update: (next: Node) => next === node,
		stopEvent: event =>
			stories !== undefined && event.target instanceof globalThis.Node && event.target !== dom && dom.contains(event.target),
		ignoreMutation: () => true,
		destroy() {
			for (const cleanup of cleanups) cleanup()
		}
	}
}

// A row's or cell's tracked insertion and deletion ("ins", "del", both): the stylesheet hides it in the revision
// view that does not have it (Original an insertion, Final a deletion), as the pages do (revisionHidden).
function revise(dom: HTMLElement, node: Node): void {
	const flags = node.attrs["revision"] as number
	const inserted = (flags & (RevisionFlag.Inserted | RevisionFlag.MovedTo)) !== 0
	const deleted = (flags & (RevisionFlag.Deleted | RevisionFlag.MovedFrom)) !== 0
	const kind = inserted && deleted ? "ins del" : inserted ? "ins" : deleted ? "del" : undefined

	if (dom.dataset["foRevision"] === kind) return

	if (kind === undefined) delete dom.dataset["foRevision"]
	else dom.dataset["foRevision"] = kind
}

// Tracked changes as inserted and deleted text (shown per revision view by the stylesheet), links, and content
// controls (a press on one is the control's); every other mark an unstyled span (runs are styled by
// decorations, from all their marks together).
export function reflowMarkViews(host: ReflowNodeHost, session: ReflowSource): Record<string, MarkViewConstructor> {
	const plain = (): { dom: HTMLElement } => ({ dom: element("span") })
	const views: Record<string, MarkViewConstructor> = Object.fromEntries(Object.keys(docxSchema.marks).map(name => [name, plain]))
	const revision =
		(tag: "ins" | "del", className: string): MarkViewConstructor =>
		(mark: Mark) => {
			const dom = element(tag, className)
			const author = mark.attrs["author"]

			if (typeof author === "string") dom.title = author

			return { dom }
		}

	// A block's node mark wraps the block (a row in its table's body): a box of no layout of its own.
	for (const name of BLOCK_NODE_MARKS) views[name] = () => ({ dom: element("span", "fo-docx-reflow-node-mark") })

	views["insertion"] = revision("ins", "fo-docx-reflow-ins")
	views["move_to"] = revision("ins", "fo-docx-reflow-ins fo-docx-reflow-moved")
	views["deletion"] = revision("del", "fo-docx-reflow-del")
	views["move_from"] = revision("del", "fo-docx-reflow-del fo-docx-reflow-moved")
	views["link"] = () => ({ dom: element("span", "fo-docx-reflow-link") })
	views["content_control"] = (_mark, view: EditorView) => {
		const dom = element("span", "fo-docx-reflow-control")

		host.target(dom, "control", session, () => {
			try {
				return view.posAtDOM(dom, 0)
			} catch {
				return undefined
			}
		})

		return { dom }
	}

	return views
}
