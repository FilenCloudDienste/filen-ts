import { useEffect, useSyncExternalStore } from "react"
import { type } from "arktype"
import type { SlideRef, SlideReview } from "@filen/office/core/presentation"
import type { PresentationSessionApi } from "@filen/office/dom/presentation"
import { usePresentationEditor } from "@/features/presentation/hooks/usePresentationSession"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { createThreadPane } from "@/features/office/components/commentThreads.logic"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"

// The review of the slide in view, as the worker last answered (review()), for the two panes: the Comments pane's
// (the slide's threads, asked again for each new render of the slide, since a comment op renders the slide again) and
// the notes pane's (the notes body, its box and its text without the comments, asked again for each new history
// revision, since a notes edit or its undo never renders the slide again). Never polled. And the Comments pane's own
// state (open, the thread opened whole, the field starting a thread; commentThreads.logic.ts). Both are read for the
// deck's own session only (slide refs of two decks coincide) and are reset when the editor closes (resetSlideReview),
// so no closed deck's review or pane state reaches the next one.

interface Asked {
	// The deck's session the review was asked of.
	readonly session?: object
	readonly slide?: SlideRef
	readonly review?: SlideReview
	// The key (render or history revision) the review answered for.
	readonly key?: number
	readonly failed: boolean
}

// The new answer, its notes body the last answer's own object when it is the same body: the text editor on it restarts
// on a new object (its seed asked again, what was typed meanwhile and not yet sent dropped).
function keepNotesRef(last: SlideReview | undefined, next: SlideReview): SlideReview {
	const was = last?.notes
	const now = next.notes

	return was !== undefined && now !== undefined && was !== now && was.slide === now.slide && was.id === now.id
		? { ...next, notes: was }
		: next
}

// `comments`: whether the answer carries the slide's comments (false: they are neither read nor kept by the worker).
function createAsker(comments: boolean) {
	let state: Asked = { failed: false }
	let asked: { readonly session: object; readonly slide: SlideRef; readonly key: number } | undefined
	let token = 0
	const listeners = new Set<() => void>()
	const replace = (next: Asked): void => {
		state = next

		for (const listener of listeners) listener()
	}
	const empty: Asked = { failed: false }

	const ask = {
		subscribe: (listener: () => void): (() => void) => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		getSnapshot: (): Asked => state,
		// The slide's review for `key` (a render or history revision).
		request: (session: Pick<PresentationSessionApi, "review">, slide: SlideRef, key: number): void => {
			if (asked?.session === session && asked.slide === slide && asked.key === key) return

			const other = state.slide !== slide || asked?.session !== session

			asked = { session, slide, key }

			const mine = ++token

			if (other) replace({ session, slide, failed: false })

			void (comments ? session.review(slide) : session.review(slide, { comments: false })).then(
				review => {
					if (mine === token) replace({ session, slide, review: keepNotesRef(state.review, review), key, failed: false })
				},
				() => {
					if (mine === token) replace({ ...state, failed: true })
				}
			)
		},
		// The slide's review again for the same key (something it answers changed with no new revision).
		again: (session: Pick<PresentationSessionApi, "review">, slide: SlideRef): void => {
			const key = asked?.slide === slide && asked.session === session ? asked.key : -1

			asked = undefined
			ask.request(session, slide, key)
		},
		// Forgets the review and what was asked (an answer still on its way is dropped).
		reset: (): void => {
			asked = undefined
			token++

			if (state !== empty) replace(empty)
		}
	}

	return ask
}

export interface ReviewState {
	readonly open: boolean
	// The deck's session the review was asked of.
	readonly session?: object
	readonly slide?: SlideRef
	readonly review?: SlideReview
	readonly failed: boolean
	// The thread shown whole (its first comment's id), and whether the field starting a thread is shown.
	readonly thread?: string
	readonly composing: boolean
}

function createReviewStore() {
	let snapshot: ReviewState | undefined
	const listeners = new Set<() => void>()
	const emit = (): void => {
		snapshot = undefined

		for (const listener of listeners) listener()
	}
	const pane = createThreadPane(emit)
	const threads = createAsker(true)

	threads.subscribe(emit)

	return {
		subscribe: (listener: () => void): (() => void) => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		getSnapshot: (): ReviewState => {
			snapshot ??= { ...threads.getSnapshot(), ...pane.get() }

			return snapshot
		},
		setOpen: pane.setOpen,
		openThread: pane.openThread,
		// The slide in view changed: its thread and field close.
		leaveSlide: pane.leave,
		compose: pane.compose,
		request: (session: Pick<PresentationSessionApi, "review">, slide: SlideRef, revision: number): void => {
			threads.request(session, slide, revision)
		},
		// The editor closed: the pane closes, its thread and field with it, and the review is forgotten.
		reset: (): void => {
			pane.openThread(undefined)
			pane.setOpen(false)
			threads.reset()
		}
	}
}

export const slideReview = createReviewStore()

const slideNotes = createAsker(false)

// The editor of a deck closed: neither its review nor the Comments pane's state reaches the next deck opened.
export function resetSlideReview(): void {
	slideReview.reset()
	slideNotes.reset()
}

export function useSlideReviewState(): ReviewState {
	return useSyncExternalStore(slideReview.subscribe, slideReview.getSnapshot, slideReview.getSnapshot)
}

// The slide in view's review with its comments, asked for while `active` (the Comments pane shows it).
export function useSlideReview(editor: PresentationRibbonEditor | undefined, active: boolean): SlideReview | undefined {
	const state = useSlideReviewState()
	const session = editor?.session
	const slide = editor?.render?.ref
	const revision = editor?.render?.revision ?? -1

	useEffect(() => {
		if (active && session !== undefined && slide !== undefined) slideReview.request(session, slide, revision)
	}, [active, session, slide, revision])

	return state.session === session && state.slide === slide ? state.review : undefined
}

const NO_ANSWER: { readonly review?: SlideReview; readonly key?: number } = {}

// The slide's notes review of `session` with the history revision it answered for (undefined: none answered for this
// slide yet).
export function useSlideNotesAnswer(
	session: object | undefined,
	slide: SlideRef | undefined
): { readonly review?: SlideReview; readonly key?: number } {
	const state = useSyncExternalStore(slideNotes.subscribe, slideNotes.getSnapshot, slideNotes.getSnapshot)

	return state.session === session && state.slide === slide ? state : NO_ANSWER
}

// The slide's notes asked for again (notes a save had taken back were dropped by the page's retract: no new revision).
export function askSlideNotesAgain(session: Pick<PresentationSessionApi, "review">, slide: SlideRef): void {
	slideNotes.again(session, slide)
}

// Asks for the slide in view's notes while `active`, and again after every op, undo or redo (the history's revision).
export function useAskSlideNotes(editor: PresentationRibbonEditor | undefined, active: boolean): void {
	const store = usePresentationEditor()?.editor.store
	const revision = useSyncExternalStore(
		(listener: () => void) => (store === undefined ? () => undefined : store.subscribe(listener)),
		() => (store === undefined ? -1 : store.getSnapshot().revision),
		() => -1
	)
	const session = editor?.session
	const slide = editor?.render?.ref

	useEffect(() => {
		if (active && session !== undefined && slide !== undefined) slideNotes.request(session, slide, revision)
	}, [active, session, slide, revision])
}

// A GUID as PresentationML writes ids ({XXXXXXXX-...}).
export function newCommentGuid(): string {
	return `{${crypto.randomUUID().toUpperCase()}}`
}

// The notes pane's layout (collapsed, and its height in px), the viewer's own on this device. Read during boot
// (lib/sdk/boot.ts), so the pane's first render has it; null while nothing is stored (the pane's own defaults).
export interface NotesLayout {
	readonly collapsed: boolean
	readonly height: number
}

const notesLayoutPreference = preloadedPreference<NotesLayout | null>({
	key: "presentation.notesLayout.v1",
	schema: type({ collapsed: "boolean", height: "number" }).or("null"),
	fallback: null,
	scope: "presentation",
	same: (a, b) => a === b || (a !== null && b !== null && a.collapsed === b.collapsed && a.height === b.height)
})

export const loadPresentationNotesLayout = notesLayoutPreference.load

export const presentationNotesLayout = notesLayoutPreference.get

export const setPresentationNotesLayout = notesLayoutPreference.set
