import { useEffect, useSyncExternalStore } from "react"
import type { SlideRef, SlideReview } from "@filen/office/core/presentation"
import type { PresentationSessionApi } from "@filen/office/dom/presentation"
import { usePresentationEditor } from "@/features/presentation/hooks/usePresentationSession"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"

// The review of the slide in view, as the worker last answered (review()), for the two panes: the Comments pane's
// (the slide's threads, asked again for each new render of the slide, since a comment op renders the slide again) and
// the notes pane's (the notes body, its box and its text without the comments, asked again for each new history
// revision, since a notes edit or its undo never renders the slide again). Never polled. And the Comments pane's own
// state (open, the thread opened whole, the field starting a thread).

interface Asked {
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

			if (other) replace({ slide, failed: false })

			void (comments ? session.review(slide) : session.review(slide, { comments: false })).then(
				review => {
					if (mine === token) replace({ slide, review: keepNotesRef(state.review, review), key, failed: false })
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
		}
	}

	return ask
}

export interface ReviewState {
	readonly open: boolean
	readonly slide?: SlideRef
	readonly review?: SlideReview
	readonly failed: boolean
	// The thread shown whole (its first comment's id), and whether the field starting a thread is shown.
	readonly thread?: string
	readonly composing: boolean
}

interface PaneState {
	readonly open: boolean
	readonly thread?: string
	readonly composing: boolean
}

type Mutable = { -readonly [K in keyof PaneState]: PaneState[K] }

function createReviewStore() {
	let pane: PaneState = { open: false, composing: false }
	let snapshot: ReviewState | undefined
	const listeners = new Set<() => void>()
	const emit = (): void => {
		snapshot = undefined

		for (const listener of listeners) listener()
	}
	const replace = (next: PaneState): void => {
		pane = next
		emit()
	}
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
			snapshot ??= { ...threads.getSnapshot(), ...pane }

			return snapshot
		},
		setOpen: (open: boolean): void => {
			if (pane.open !== open) replace({ ...pane, open, ...(open ? {} : { composing: false }) })
		},
		openThread: (thread: string | undefined): void => {
			const next: Mutable = { ...pane, composing: false }

			if (thread === undefined) delete next.thread
			else next.thread = thread

			replace(next)
		},
		// The slide in view changed: its thread and field close.
		leaveSlide: (): void => {
			if (pane.thread === undefined && !pane.composing) return

			const next: Mutable = { ...pane, composing: false }

			delete next.thread
			replace(next)
		},
		compose: (composing: boolean): void => {
			replace(composing ? { ...pane, open: true, composing: true } : { ...pane, composing: false })
		},
		request: (session: Pick<PresentationSessionApi, "review">, slide: SlideRef, revision: number): void => {
			threads.request(session, slide, revision)
		}
	}
}

export const slideReview = createReviewStore()

const slideNotes = createAsker(false)

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

	return state.slide === slide ? state.review : undefined
}

// The slide in view's notes (the review without its comments) as last answered.
export function useSlideNotes(slide: SlideRef | undefined): SlideReview | undefined {
	return useSlideNotesAnswer(slide).review
}

// The slide's notes review with the history revision it answered for (undefined: none answered for this slide yet).
export function useSlideNotesAnswer(slide: SlideRef | undefined): { readonly review?: SlideReview; readonly key?: number } {
	const state = useSyncExternalStore(slideNotes.subscribe, slideNotes.getSnapshot, slideNotes.getSnapshot)

	return state.slide === slide ? state : {}
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

// Focuses `element`, and again in the next frame if focus fell back to a container of it: a frame after a focused
// element (a field just closed, a row just opened) is removed, the overlay's focus manager puts focus back on the
// dialog, which would undo a focus set in between.
export function focusSettled(element: HTMLElement | null): void {
	if (element === null) return

	element.focus({ preventScroll: true })
	requestAnimationFrame(() => {
		const now = element.ownerDocument.activeElement

		if (element.isConnected && now !== element && (now === null || now.contains(element))) element.focus({ preventScroll: true })
	})
}

// A GUID as PresentationML writes ids ({XXXXXXXX-...}).
export function newCommentGuid(): string {
	return `{${crypto.randomUUID().toUpperCase()}}`
}
