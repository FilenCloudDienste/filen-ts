import { boolArg, choiceArg, field, idArg, type DocxCommandInfo, type DocxCommandParser } from "./base"

// Tracked changes: recording, accepting and rejecting, and how they show.

// As DocxMarkupMode (Word's Review > Display for Review).
export const DOCX_MARKUP_VIEWS = ["all", "simple", "none", "original"] as const

export type DocxMarkupView = (typeof DOCX_MARKUP_VIEWS)[number]

export type ReviewCommand =
	// Without `on`: toggles.
	| { readonly type: "review.track"; readonly on?: boolean }
	// Without `id`: the change at the selection. `next`: then selects the next change (Word's "Accept and Move
	// to Next"); without it the selection stays (Word's "Accept This Change").
	| { readonly type: "review.accept"; readonly id?: string; readonly next?: boolean }
	| { readonly type: "review.reject"; readonly id?: string; readonly next?: boolean }
	| { readonly type: "review.acceptAll" }
	| { readonly type: "review.rejectAll" }
	| { readonly type: "review.next" }
	| { readonly type: "review.prev" }
	| { readonly type: "view.markup"; readonly mode: DocxMarkupView }

const document = { scope: "document", group: "review", context: "revision" } as const

export const REVIEW_COMMANDS: readonly DocxCommandInfo<ReviewCommand["type"]>[] = [
	// Word's Ctrl+Shift+E (Cmd+Shift+E): the host toggles from the review state, asking for the author to turn it on.
	{
		type: "review.track",
		labelKey: "docx.review.track",
		icon: "track-changes",
		shortcut: "mod+shift+e",
		hostShortcut: true,
		write: true,
		author: true,
		...document
	},
	{ type: "review.accept", labelKey: "docx.review.accept", icon: "accept", write: true, ...document },
	{ type: "review.reject", labelKey: "docx.review.reject", icon: "reject", write: true, ...document },
	{ type: "review.acceptAll", labelKey: "docx.review.acceptAll", icon: "accept-all", write: true, ...document },
	{ type: "review.rejectAll", labelKey: "docx.review.rejectAll", icon: "reject-all", write: true, ...document },
	{ type: "review.next", labelKey: "docx.review.next", icon: "change-next", write: false, ...document },
	{ type: "review.prev", labelKey: "docx.review.prev", icon: "change-prev", write: false, ...document },
	// How the document shows changes, switched in place: nothing in the file changes.
	{ type: "view.markup", labelKey: "docx.view.markup", icon: "markup", write: false, scope: "document", group: "review", input: "choice" }
]

const VIEWS = new Set<string>(DOCX_MARKUP_VIEWS)

export const parseReviewCommand: DocxCommandParser<ReviewCommand> = (type, value) => {
	switch (type) {
		case "review.track": {
			if (field(value, "on") === undefined) return { type }

			const on = boolArg(value, "on")

			return on === undefined ? undefined : { type, on }
		}
		case "review.accept":
		case "review.reject": {
			const id = field(value, "id") === undefined ? null : idArg(value, "id")

			if (id === undefined) return undefined
			if (field(value, "next") === undefined) return id === null ? { type } : { type, id }

			const next = boolArg(value, "next")

			if (next === undefined) return undefined

			return id === null ? { type, next } : { type, id, next }
		}
		case "view.markup": {
			const mode = choiceArg<DocxMarkupView>(value, "mode", VIEWS)

			return mode === undefined ? undefined : { type, mode }
		}
		default:
			return { type }
	}
}
