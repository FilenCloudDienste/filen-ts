import { formatShortDate } from "@/lib/formatDate"

// What the generic comment-thread list (commentThreads.tsx) shows and how it moves focus, free of any one editor:
// the comment and thread shapes an editor maps its own comments onto, the pane's open/thread/field state an editor
// keeps where its ribbon reads it, and where focus goes once the list shows what an action changed.

// One comment as the list shows it. `id` is unique within its thread; `authorId` keys the author's colour; `created`
// is an ISO date ("" when the file has none).
export interface ThreadComment {
	readonly id: string
	readonly author: string
	readonly authorId: string
	readonly text: string
	readonly created: string
	// Whether its author may change its text (the list offers Edit on one's own comments only).
	readonly editable: boolean
}

// One thread: its first comment and replies in order. `id` (its first comment's id) is unique in the list.
// `resolvable`: whether it offers Resolve/Reopen. `status`: a state shown read-only beside an unresolved thread.
// `detail`: where the thread sits (a page), shown under its row.
export interface CommentThread<C extends ThreadComment = ThreadComment> {
	readonly root: C
	readonly replies: readonly C[]
	readonly resolved: boolean
	readonly resolvable: boolean
	readonly status?: string
	readonly detail?: string
}

// The pane's own state: open, the thread shown whole (its first comment's id), and whether the field starting a
// thread is shown.
export interface ThreadPaneState {
	readonly open: boolean
	readonly thread?: string
	readonly composing: boolean
}

type MutablePane = { -readonly [K in keyof ThreadPaneState]: ThreadPaneState[K] }

// The pane state as a small store an editor's module keeps (its ribbon and its pane read it); `changed` runs after
// every change.
export function createThreadPane(changed: () => void) {
	let pane: ThreadPaneState = { open: false, composing: false }
	const replace = (next: ThreadPaneState): void => {
		pane = next
		changed()
	}

	return {
		get: (): ThreadPaneState => pane,
		setOpen: (open: boolean): void => {
			if (pane.open !== open) replace({ ...pane, open, ...(open ? {} : { composing: false }) })
		},
		openThread: (thread: string | undefined): void => {
			const next: MutablePane = { ...pane, composing: false }

			if (thread === undefined) delete next.thread
			else next.thread = thread

			replace(next)
		},
		// What the pane shows moved elsewhere (another slide): its thread and field close.
		leave: (): void => {
			if (pane.thread === undefined && !pane.composing) return

			const next: MutablePane = { ...pane, composing: false }

			delete next.thread
			replace(next)
		},
		compose: (composing: boolean): void => {
			replace(composing ? { ...pane, open: true, composing: true } : { ...pane, composing: false })
		}
	}
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

// The characters of a thread's first comment its row's accessible name carries.
const EXCERPT_CHARS = 80

export function shownDate(created: string): string {
	return created === "" || Number.isNaN(Date.parse(created)) ? "" : formatShortDate(created)
}

export function excerptOf(text: string): string {
	const flat = text.replace(/\s+/gu, " ").trim()

	return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS - 1)}…`
}

// Where focus goes once the list shows it: a thread's row again (its thread was closed), the row of a thread just
// posted (`count`: threads before it; a form that renames ids puts a new thread last), or the row in the place of a
// deleted thread; -1: no thread is left. Each is for the scope (slide) it was made in.
export type FocusWant = { readonly scope: unknown } & (
	| { readonly kind: "thread"; readonly id: string }
	| { readonly kind: "posted"; readonly id: string; readonly count: number }
	| { readonly kind: "gone"; readonly id: string; readonly index: number }
)

export function wantedIndex(want: FocusWant, threads: readonly CommentThread[]): number | undefined {
	if (threads.length === 0) return want.kind === "posted" ? undefined : -1

	const at = threads.findIndex(thread => thread.root.id === want.id)

	switch (want.kind) {
		case "thread":
			return Math.max(0, at)
		case "posted":
			return at >= 0 ? at : threads.length > want.count ? threads.length - 1 : undefined
		case "gone":
			return at >= 0 ? undefined : Math.min(want.index, threads.length - 1)
	}
}
