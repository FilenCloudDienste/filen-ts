import { countRange, countSession, type DocxTextCount, type PagedEditor } from "@filen/office/core/docx/paged"

// Word's word count in the editor's status bar: the body's words ("N words"), and with a selection the
// selection's ("x of N words"). Counted once typing pauses, never inside a keystroke, and only again for what
// changed: the core keeps a count per block, so a recount after an edit reads the blocks it changed. Read with
// useSyncExternalStore by the status bar's indicator alone, so a recount re-renders nothing else.

// The pause after the last edit or selection change before counting.
export const WORD_COUNT_IDLE_MS = 400
// A long first count gives the page a turn this often (ms).
const COUNT_SLICE_MS = 8

export interface DocxWordCountState {
	// undefined until the first count.
	readonly words: number | undefined
	// The selection's words; undefined without a selection (or one in another story than the body).
	readonly selected: number | undefined
}

// What the store counts: the editor, or a stand-in in tests.
export interface DocxCountSource {
	// Called on every change that may change a count (an edit, a selection change, a story switch).
	readonly subscribe: (listener: () => void) => () => void
	// Identifies what `count` reads (the body's document): no recount while it is the same.
	readonly documentKey: () => unknown
	// Identifies the selection `selected` reads.
	readonly selectionKey: () => unknown
	readonly count: () => Promise<number>
	readonly selected: () => number | undefined
}

export interface DocxWordCountStore {
	readonly get: () => DocxWordCountState
	readonly subscribe: (listener: () => void) => () => void
}

const NONE: DocxWordCountState = { words: undefined, selected: undefined }

function sliced(): { pause: () => Promise<void>; sliceMs: number; now: () => number } {
	return {
		pause: () =>
			new Promise<void>(resolve => {
				setTimeout(resolve, 0)
			}),
		sliceMs: COUNT_SLICE_MS,
		now: () => performance.now()
	}
}

// The editor's body as a count source: its document, and its selection while the body is being edited.
export function editorCountSource(editor: PagedEditor): DocxCountSource {
	const body = editor.body.session
	const bodyActive = (): boolean => editor.activeStory === body.story.story.index
	// The document as the revision view shows it (another markup view counts other text).
	let shown: { doc: unknown; view: unknown } = { doc: undefined, view: undefined }

	return {
		subscribe: listener => {
			const stopSession = body.subscribe(listener)
			const stopEditor = editor.subscribe(event => {
				if (event.type === "story" || event.type === "pages") listener()
			})

			return () => {
				stopSession()
				stopEditor()
			}
		},
		documentKey: () => {
			if (shown.doc !== body.state.doc || shown.view !== editor.edits.view) shown = { doc: body.state.doc, view: editor.edits.view }

			return shown
		},
		selectionKey: () => (bodyActive() ? body.state.selection : undefined),
		count: async () => (await countSession(body, editor.edits.view, sliced())).words,
		selected: () => {
			const { from, to, empty } = body.state.selection

			return !bodyActive() || empty ? undefined : countRange(body, from, to, editor.edits.view).words
		}
	}
}

// Counts `source` once its changes pause, and again after each later pause that changed what is counted, while
// anything listens (made in render: it does nothing until then, and stops once nothing does).
export function createDocxWordCountStore(source: DocxCountSource, idleMs = WORD_COUNT_IDLE_MS): DocxWordCountStore {
	let state = NONE
	let countedDocument: unknown = undefined
	let countedSelection: unknown = undefined
	let timer: ReturnType<typeof setTimeout> | undefined = undefined
	let stop: (() => void) | undefined = undefined
	// Bumped per count started: a slower count finishing after a later one is dropped.
	let run = 0
	const listeners = new Set<() => void>()

	const publish = (next: DocxWordCountState): void => {
		if (next.words === state.words && next.selected === state.selected) return

		state = next

		for (const listener of listeners) listener()
	}

	const recount = (): void => {
		timer = undefined

		if (stop === undefined) return

		const documentKey = source.documentKey()
		const selectionKey = source.selectionKey()

		if (selectionKey !== countedSelection || documentKey !== countedDocument) {
			countedSelection = selectionKey
			publish({ ...state, selected: source.selected() })
		}

		if (documentKey === countedDocument) return

		countedDocument = documentKey
		run += 1

		const own = run

		source.count().then(
			words => {
				if (own === run) publish({ ...state, words })
			},
			() => {
				// Counted again after the next change.
				if (own === run) countedDocument = undefined
			}
		)
	}

	const schedule = (): void => {
		if (timer !== undefined) clearTimeout(timer)

		timer = setTimeout(recount, idleMs)
	}

	return {
		get: () => state,
		subscribe: listener => {
			listeners.add(listener)

			if (stop === undefined) {
				stop = source.subscribe(schedule)
				recount()
			}

			return () => {
				listeners.delete(listener)

				if (listeners.size > 0 || stop === undefined) return

				stop()
				stop = undefined

				if (timer !== undefined) clearTimeout(timer)

				timer = undefined
			}
		}
	}
}

// The rows of Word's Word Count dialog, in its order.
export interface DocxWordCountStats extends DocxTextCount {
	readonly pages: number
	readonly lines: number
}

export const WORD_COUNT_ROWS = [
	{ key: "pages", label: "previewDocxWordCountPages" },
	{ key: "words", label: "previewDocxWordCountWords" },
	{ key: "charactersNoSpaces", label: "previewDocxWordCountCharactersNoSpaces" },
	{ key: "characters", label: "previewDocxWordCountCharacters" },
	{ key: "paragraphs", label: "previewDocxWordCountParagraphs" },
	{ key: "lines", label: "previewDocxWordCountLines" }
] as const satisfies readonly { key: keyof DocxWordCountStats; label: string }[]
