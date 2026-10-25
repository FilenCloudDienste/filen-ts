import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state"
import { EditorView, type Command } from "@codemirror/view"
import { redoDepth, undoDepth } from "@codemirror/commands"
import { indentUnit } from "@codemirror/language"
import { codeLanguageSupport, codeLineNumbers } from "@filen/office/dom/code"
import type { CodeLanguageId } from "@filen/office/core/code"
import { CodeFind, codeFindExtension } from "@/features/preview/lib/codeFind"
import type { CodeViewSettings } from "@/features/preview/lib/codeViewSettings"
import type { EditorKeymapCommands } from "@/features/preview/lib/codeMirrorShared"

// What the text and code viewers' command bar works through (codeCommandBar.tsx): the editor's switchable parts in
// compartments of their own (wrapping, line numbers, the language, indentation), find (codeFind.ts), and the status
// (position, selection, undo and redo) in a small store fed by one update listener and settled once a frame. A
// keystroke reaches the store's readers (the position and the undo and redo buttons) only, never the bar.

export interface CodeStatus {
	// 1-based.
	readonly line: number
	readonly column: number
	// Characters selected, over every range.
	readonly selected: number
	readonly canUndo: boolean
	readonly canRedo: boolean
}

const START: CodeStatus = { line: 1, column: 1, selected: 0, canUndo: false, canRedo: false }

export function codeStatusOf(state: EditorState): CodeStatus {
	const head = state.selection.main.head
	const line = state.doc.lineAt(head)

	return {
		line: line.number,
		column: head - line.from + 1,
		selected: state.selection.ranges.reduce((sum, range) => sum + range.to - range.from, 0),
		canUndo: undoDepth(state) > 0,
		canRedo: redoDepth(state) > 0
	}
}

function sameStatus(a: CodeStatus, b: CodeStatus): boolean {
	return a.line === b.line && a.column === b.column && a.selected === b.selected && a.canUndo === b.canUndo && a.canRedo === b.canRedo
}

// Tabs, or a width in spaces.
export type CodeIndent = "tabs" | 2 | 4 | 8

export const CODE_INDENTS: readonly CodeIndent[] = ["tabs", 2, 4, 8]

// Lines read to tell how a file indents.
const INDENT_PROBE_LINES = 2000

// How the file indents: tabs when more indented lines start with one, else the most common step between the
// indents of neighbouring lines (2 when nothing tells).
export function detectIndent(text: string): CodeIndent {
	let tabs = 0
	let spaces = 0
	let previous = 0
	const steps = new Map<number, number>()
	let start = 0

	for (let read = 0; read < INDENT_PROBE_LINES && start < text.length; read++) {
		let end = text.indexOf("\n", start)

		if (end < 0) {
			end = text.length
		}

		const first = text.charCodeAt(start)

		if (first === 9) {
			tabs++
		} else {
			let width = 0

			while (text.charCodeAt(start + width) === 32) {
				width++
			}

			// Blank lines say nothing.
			if (start + width < end && text.charCodeAt(start + width) !== 13) {
				if (width > 0) {
					spaces++
				}

				const step = Math.abs(width - previous)

				if (step > 0) {
					steps.set(step, (steps.get(step) ?? 0) + 1)
				}

				previous = width
			}
		}

		start = end + 1
	}

	if (tabs > spaces) {
		return "tabs"
	}

	let best: CodeIndent = 2
	let bestCount = 0

	for (const width of [2, 4, 8] as const) {
		const count = steps.get(width) ?? 0

		if (count > bestCount) {
			best = width
			bestCount = count
		}
	}

	return best
}

function indentExtension(indent: CodeIndent): Extension {
	return indent === "tabs"
		? [EditorState.tabSize.of(4), indentUnit.of("\t")]
		: [EditorState.tabSize.of(indent), indentUnit.of(" ".repeat(indent))]
}

function languageExtension(language: CodeLanguageId | ""): Extension {
	return language === "" ? [] : codeLanguageSupport(language)
}

export interface CodeChromeInit {
	readonly settings: CodeViewSettings
	readonly language: CodeLanguageId | ""
	readonly indent: CodeIndent
	readonly editable: boolean
}

export class CodeChrome {
	private readonly wrap = new Compartment()
	private readonly lines = new Compartment()
	private readonly language = new Compartment()
	private readonly indent = new Compartment()
	private view: EditorView | null = null
	private status: CodeStatus = START
	private readonly listeners = new Set<() => void>()
	private frame = 0
	readonly find: CodeFind
	// Wrapping, line numbers, language and indentation, find, and the status listener: in the editor's
	// configuration in place of its own wrapping, line numbers and language.
	readonly extensions: Extension
	// The editor's find, replace and go to line keys, sent to the bar.
	readonly keymap: EditorKeymapCommands
	// The bar's go to line dialog, for the editor's key.
	private goToLineRequest: (() => void) | null = null

	constructor(init: CodeChromeInit) {
		this.find = new CodeFind(() => this.view, init.editable)
		this.extensions = [
			this.wrap.of(init.settings.wrap ? EditorView.lineWrapping : []),
			this.lines.of(init.settings.lineNumbers ? codeLineNumbers : []),
			this.language.of(languageExtension(init.language)),
			this.indent.of(indentExtension(init.indent)),
			codeFindExtension,
			EditorView.updateListener.of(update => {
				if (update.docChanged || update.selectionSet) {
					this.schedule()
					this.find.schedule()
				}
			})
		]

		const openFind =
			(replace: boolean): Command =>
			() => {
				this.find.open(replace)

				return true
			}
		const step =
			(direction: 1 | -1): Command =>
			() => {
				if (this.find.get().query.length > 0) {
					this.find.step(direction)
				} else {
					this.find.open(false)
				}

				return true
			}

		this.keymap = {
			find: openFind(false),
			replace: openFind(init.editable),
			findNext: step(1),
			findPrevious: step(-1),
			goToLine: () => {
				this.goToLineRequest?.()

				return true
			}
		}
	}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	readonly getStatus = (): CodeStatus => this.status

	onGoToLine(request: () => void): () => void {
		this.goToLineRequest = request

		return () => {
			if (this.goToLineRequest === request) {
				this.goToLineRequest = null
			}
		}
	}

	attach(view: EditorView | null): void {
		this.view = view

		if (view !== null) {
			this.settle(view.state)
		}
	}

	private schedule(): void {
		if (this.frame !== 0) {
			return
		}

		this.frame = requestAnimationFrame(() => {
			this.frame = 0

			if (this.view !== null) {
				this.settle(this.view.state)
			}
		})
	}

	private settle(state: EditorState): void {
		const next = codeStatusOf(state)

		if (!sameStatus(next, this.status)) {
			this.status = next

			for (const listener of this.listeners) {
				listener()
			}
		}
	}

	dispose(): void {
		cancelAnimationFrame(this.frame)
		this.frame = 0
		this.find.dispose()
		this.view = null
	}

	private reconfigure(compartment: Compartment, extension: Extension): void {
		this.view?.dispatch({ effects: compartment.reconfigure(extension) })
	}

	setWrap(wrap: boolean): void {
		this.reconfigure(this.wrap, wrap ? EditorView.lineWrapping : [])
	}

	setLineNumbers(lineNumbers: boolean): void {
		this.reconfigure(this.lines, lineNumbers ? codeLineNumbers : [])
	}

	setLanguage(language: CodeLanguageId | ""): void {
		this.reconfigure(this.language, languageExtension(language))
	}

	setIndent(indent: CodeIndent): void {
		this.reconfigure(this.indent, indentExtension(indent))
	}

	// The font size changed (CSS only): the editor measures its lines again.
	remeasure(): void {
		this.view?.requestMeasure()
	}

	// A command of the bar, on the editor, which keeps focus.
	run(command: Command): void {
		const view = this.view

		if (view !== null) {
			command(view)
			view.focus()
		}
	}

	lineCount(): number {
		return this.view?.state.doc.lines ?? 1
	}

	// 1-based, clamped; the line is centred.
	goToLine(line: number, column: number): void {
		const view = this.view

		if (view === null) {
			return
		}

		const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines))
		const at = target.from + Math.min(Math.max(0, column - 1), target.length)

		view.dispatch({
			selection: EditorSelection.cursor(at),
			effects: EditorView.scrollIntoView(at, { y: "center" }),
			userEvent: "select"
		})
		view.focus()
	}

	text(): string {
		return this.view?.state.doc.toString() ?? ""
	}

	focus(): void {
		this.view?.focus()
	}
}
