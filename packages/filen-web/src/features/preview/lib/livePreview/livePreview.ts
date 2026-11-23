import { syntaxTree } from "@codemirror/language"
import { Facet, Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state"
import { EditorView, keymap, ViewPlugin, type Command, type ViewUpdate } from "@codemirror/view"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { linkAt } from "@/features/preview/lib/livePreview/commands"
import {
	buildLivePreview,
	type LivePreviewBlock,
	type LivePreviewConfig,
	type LivePreviewDecorations
} from "@/features/preview/lib/livePreview/decorations"
import "@/features/preview/lib/livePreview/livePreview.css"

// Live preview for a markdown editor (CodeMirror 6): the document stays its exact source, styled in place from the
// markdown syntax tree (decorations.ts), its syntax marks hidden except where the selection touches them. Shared by
// every markdown editor (the file preview's, the notes editor's): a host adds livePreview(config) to the editor, in a
// compartment of its own to switch it with Source, and the same view, buffer and history carry on.
//
// Cost: decorations exist for the viewport and a margin only, rebuilt from the syntax tree when the document, the
// selection, the tree (a parse catching up), the config or the stretch changes; scrolling past the stretch moves it
// (one rebuild), and widgets compare by what they show, so an unchanged one keeps its DOM.

// Beyond the viewport on either side, at least: a scroll within it rebuilds nothing.
const MIN_MARGIN = 2000

interface Stretch {
	readonly from: number
	readonly to: number
}

interface LivePreviewValue extends LivePreviewDecorations, Stretch {
	// The editor has been focused: the selection now shows the syntax it touches.
	readonly reveal: boolean
}

const DEFAULT_CONFIG: LivePreviewConfig = {
	image: () => null,
	openLink: () => undefined,
	labels: { imageNotLoaded: alt => alt, task: "", openLink: "" },
	math: null,
	mermaid: null
}

const configFacet = Facet.define<LivePreviewConfig, LivePreviewConfig>({
	combine: values => values[0] ?? DEFAULT_CONFIG
})

const setStretch = StateEffect.define<Stretch>()
const revealEffect = StateEffect.define()

function stretchAround(state: EditorState, from: number, to: number): Stretch {
	const margin = Math.max(MIN_MARGIN, to - from)

	return { from: Math.max(0, from - margin), to: Math.min(state.doc.length, to + margin) }
}

function compute(state: EditorState, stretch: Stretch, reveal: boolean): LivePreviewValue {
	const { from, to } = stretch

	return { ...buildLivePreview(state, from, to, reveal, state.facet(configFacet)), from, to, reveal }
}

export const livePreviewField = StateField.define<LivePreviewValue>({
	// Until the view reports its viewport: around the selection.
	create: state => {
		const head = state.selection.main.head

		return compute(state, stretchAround(state, head, head), false)
	},
	update: (value, tr) => {
		let stretch: Stretch = value
		let reveal = value.reveal
		let changed = false

		for (const effect of tr.effects) {
			if (effect.is(setStretch)) {
				stretch = effect.value
				changed = true
			} else if (effect.is(revealEffect) && !reveal) {
				reveal = true
				changed = true
			}
		}

		if (tr.docChanged) {
			stretch = { from: tr.changes.mapPos(stretch.from, -1), to: tr.changes.mapPos(stretch.to, 1) }
			changed = true
		}

		if (
			changed ||
			(reveal && tr.selection !== undefined) ||
			syntaxTree(tr.state) !== syntaxTree(tr.startState) ||
			tr.state.facet(configFacet) !== tr.startState.facet(configFacet) ||
			tr.state.readOnly !== tr.startState.readOnly
		) {
			return compute(tr.state, stretch, reveal)
		}

		return value
	},
	provide: field => EditorView.decorations.from(field, value => value.decorations)
})

// Moves the stretch once the viewport leaves it. Dispatched after the update that saw it (a plugin may not dispatch
// during one), before the frame paints.
const stretchSync = ViewPlugin.fromClass(
	class {
		private destroyed = false
		private queued = false

		readonly view: EditorView

		constructor(view: EditorView) {
			this.view = view
			this.check()
		}

		update(update: ViewUpdate): void {
			if (update.viewportChanged || update.docChanged) {
				this.check()
			}
		}

		check(): void {
			const { from, to } = this.view.viewport
			const value = this.view.state.field(livePreviewField, false)

			if (value === undefined || this.queued || (from >= value.from && to <= value.to)) {
				return
			}

			this.queued = true
			queueMicrotask(() => {
				this.queued = false

				if (this.destroyed) {
					return
				}

				const viewport = this.view.viewport

				this.view.dispatch({ effects: setStretch.of(stretchAround(this.view.state, viewport.from, viewport.to)) })
			})
		}

		destroy(): void {
			this.destroyed = true
		}
	}
)

// The block on the line after (or before) the cursor's: the arrow keys step into it (it shows its source) rather than
// past it.
function blockBeside(state: EditorState, forward: boolean): LivePreviewBlock | null {
	const selection = state.selection.main
	const blocks = state.field(livePreviewField, false)?.blocks ?? []

	if (!selection.empty) {
		return null
	}

	const line = state.doc.lineAt(selection.head)

	return blocks.find(block => (forward ? block.from === line.to + 1 : block.to === line.from - 1)) ?? null
}

function stepIntoBlock(forward: boolean): Command {
	return view => {
		const block = blockBeside(view.state, forward)

		if (block === null) {
			return false
		}

		const at = forward ? block.from : view.state.doc.lineAt(block.to).from

		view.dispatch({ selection: { anchor: at }, scrollIntoView: true, userEvent: "select" })

		return true
	}
}

const IS_MAC = isMacPlatform()

const handlers = EditorView.domEventHandlers({
	// Mod+click opens a link; a plain click places the cursor (showing the link's source) as anywhere else.
	mousedown: (event, view) => {
		if (event.button !== 0 || !(IS_MAC ? event.metaKey : event.ctrlKey)) {
			return false
		}

		const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
		const url = pos === null ? null : linkAt(view.state, pos)

		if (url === null) {
			return false
		}

		event.preventDefault()
		view.state.facet(configFacet).openLink(url)

		return true
	}
})

const STATIC: Extension = [
	livePreviewField,
	stretchSync,
	handlers,
	EditorView.focusChangeEffect.of((state, focusing) =>
		focusing && state.field(livePreviewField, false)?.reveal === false ? revealEffect.of(null) : null
	),
	Prec.high(
		keymap.of([
			{ key: "ArrowDown", run: stepIntoBlock(true) },
			{ key: "ArrowUp", run: stepIntoBlock(false) }
		])
	),
	EditorView.editorAttributes.of({ class: "cm-lp" })
]

// The live preview, drawn through `config` (pass one value for the editor's life: a new one rebuilds the decorations).
export function livePreview(config: LivePreviewConfig): Extension {
	return [configFacet.of(config), STATIC]
}
