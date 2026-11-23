import { WidgetType, type EditorView } from "@codemirror/view"
import { toggleTask } from "@/features/preview/lib/livePreview/commands"

// The live preview's widgets (livePreview.ts). Each compares by what it shows (eq), so a rebuild of the decorations
// keeps the DOM of every widget that did not change; none holds a reference to the document.

// A run of a table cell's inline text, with the formatting the Read view would give it.
export interface InlineRun {
	readonly text: string
	readonly strong: boolean
	readonly em: boolean
	readonly strike: boolean
	readonly code: boolean
	readonly link: boolean
}

export type TableAlign = "left" | "center" | "right" | null

export interface TableModel {
	readonly align: readonly TableAlign[]
	readonly header: readonly (readonly InlineRun[])[]
	readonly rows: readonly (readonly (readonly InlineRun[])[])[]
}

// Draws an embed (a formula, a diagram) into `dom`; returns its cleanup, run when the widget leaves the editor.
export type EmbedRenderer = (dom: HTMLElement, source: string, display: boolean) => () => void

function runsDom(document: Document, runs: readonly InlineRun[], into: HTMLElement): void {
	for (const run of runs) {
		let node: Node = document.createTextNode(run.text)

		const wrap = (tag: string, className?: string): void => {
			const element = document.createElement(tag)

			if (className !== undefined) {
				element.className = className
			}

			element.append(node)
			node = element
		}

		if (run.code) {
			wrap("code", "cm-lp-code")
		}

		if (run.strike) {
			wrap("del")
		}

		if (run.em) {
			wrap("em")
		}

		if (run.strong) {
			wrap("strong")
		}

		if (run.link) {
			wrap("span", "cm-lp-link")
		}

		into.append(node)
	}
}

export class TableWidget extends WidgetType {
	readonly source: string
	readonly model: TableModel

	constructor(source: string, model: TableModel) {
		super()
		this.source = source
		this.model = model
	}

	override eq(other: TableWidget): boolean {
		return other.source === this.source
	}

	toDOM(view: EditorView): HTMLElement {
		const document = view.dom.ownerDocument
		const wrap = document.createElement("div")
		const table = document.createElement("table")
		const head = document.createElement("thead")
		const headRow = document.createElement("tr")

		wrap.className = "cm-lp-table"

		const cell = (tag: "th" | "td", runs: readonly InlineRun[], column: number): HTMLElement => {
			const element = document.createElement(tag)
			const align = this.model.align[column] ?? null

			if (align !== null) {
				element.style.textAlign = align
			}

			runsDom(document, runs, element)

			return element
		}

		this.model.header.forEach((runs, column) => {
			headRow.append(cell("th", runs, column))
		})
		head.append(headRow)
		table.append(head)

		if (this.model.rows.length > 0) {
			const body = document.createElement("tbody")

			for (const row of this.model.rows) {
				const tr = document.createElement("tr")

				row.forEach((runs, column) => {
					tr.append(cell("td", runs, column))
				})
				body.append(tr)
			}

			table.append(body)
		}

		wrap.append(table)

		return wrap
	}

	// A click places the cursor in the table, which shows its source.
	override ignoreEvent(): boolean {
		return false
	}
}

export class CheckboxWidget extends WidgetType {
	readonly checked: boolean
	readonly readOnly: boolean
	readonly label: string

	constructor(checked: boolean, readOnly: boolean, label: string) {
		super()
		this.checked = checked
		this.readOnly = readOnly
		this.label = label
	}

	override eq(other: CheckboxWidget): boolean {
		return other.checked === this.checked && other.readOnly === this.readOnly && other.label === this.label
	}

	toDOM(view: EditorView): HTMLElement {
		const input = view.dom.ownerDocument.createElement("input")

		input.type = "checkbox"
		input.className = "cm-lp-task"
		input.checked = this.checked
		input.disabled = this.readOnly
		input.tabIndex = -1
		input.setAttribute("aria-label", this.label)
		// The source decides: the box redraws from the toggled text, never from its own click.
		input.addEventListener("mousedown", event => {
			event.preventDefault()

			if (this.readOnly || view.state.readOnly) {
				return
			}

			const spec = toggleTask(view.state, view.posAtDOM(input))

			if (spec !== null) {
				view.dispatch(spec)
			}
		})
		input.addEventListener("click", event => {
			event.preventDefault()
		})

		return input
	}

	override ignoreEvent(): boolean {
		return true
	}
}

export class ImageWidget extends WidgetType {
	readonly src: string | null
	readonly alt: string
	readonly missing: string

	constructor(src: string | null, alt: string, missing: string) {
		super()
		this.src = src
		this.alt = alt
		this.missing = missing
	}

	override eq(other: ImageWidget): boolean {
		return other.src === this.src && other.alt === this.alt && other.missing === this.missing
	}

	toDOM(view: EditorView): HTMLElement {
		const document = view.dom.ownerDocument

		if (this.src === null) {
			const span = document.createElement("span")

			span.className = "cm-lp-image-missing"
			span.textContent = this.missing

			return span
		}

		const img = document.createElement("img")

		img.className = "cm-lp-image"
		img.alt = this.alt
		img.referrerPolicy = "no-referrer"
		img.draggable = false
		img.src = this.src

		return img
	}

	override ignoreEvent(): boolean {
		return false
	}
}

class BulletWidget extends WidgetType {
	override eq(): boolean {
		return true
	}

	toDOM(view: EditorView): HTMLElement {
		const span = view.dom.ownerDocument.createElement("span")

		span.className = "cm-lp-bullet"
		span.textContent = "•"
		span.setAttribute("aria-hidden", "true")

		return span
	}
}

export const BULLET = new BulletWidget()

// A fence's language, in place of its opening line.
export class FenceLabelWidget extends WidgetType {
	readonly language: string

	constructor(language: string) {
		super()
		this.language = language
	}

	override eq(other: FenceLabelWidget): boolean {
		return other.language === this.language
	}

	toDOM(view: EditorView): HTMLElement {
		const span = view.dom.ownerDocument.createElement("span")

		span.className = "cm-lp-fence-label"
		span.textContent = this.language

		return span
	}
}

const cleanups = new WeakMap<HTMLElement, () => void>()

export class EmbedWidget extends WidgetType {
	readonly source: string
	readonly display: boolean
	readonly render: EmbedRenderer
	readonly height: number

	constructor(source: string, display: boolean, render: EmbedRenderer, height: number) {
		super()
		this.source = source
		this.display = display
		this.render = render
		this.height = height
	}

	override eq(other: EmbedWidget): boolean {
		return other.source === this.source && other.display === this.display && other.render === this.render
	}

	toDOM(view: EditorView): HTMLElement {
		const element = view.dom.ownerDocument.createElement(this.display ? "div" : "span")

		element.className = this.display ? "cm-lp-embed cm-lp-embed-block" : "cm-lp-embed"
		cleanups.set(element, this.render(element, this.source, this.display))

		return element
	}

	override destroy(dom: HTMLElement): void {
		cleanups.get(dom)?.()
		cleanups.delete(dom)
	}

	override get estimatedHeight(): number {
		return this.height
	}

	// The embed's own controls (a diagram's buttons) keep their clicks; elsewhere a click shows the source.
	override ignoreEvent(event: Event): boolean {
		return event.target instanceof Element && event.target.closest("button") !== null
	}
}
