import { idArg, stringArg, type DocxCommandInfo, type DocxCommandParser } from "./base"

// Comments: their content lives in stories of their own, their anchors in the story the comment is on.

// Comment text arrives as plain text, paragraphs separated by line feeds.
export const MAX_COMMENT_TEXT = 100_000

export type CommentCommand =
	| { readonly type: "comment.add"; readonly text: string }
	| { readonly type: "comment.reply"; readonly id: string; readonly text: string }
	| { readonly type: "comment.edit"; readonly id: string; readonly text: string }
	| { readonly type: "comment.resolve"; readonly id: string }
	| { readonly type: "comment.reopen"; readonly id: string }
	| { readonly type: "comment.delete"; readonly id: string }
	| { readonly type: "comment.next" }
	| { readonly type: "comment.prev" }

const document = { scope: "document", group: "comment", context: "comment" } as const

export const COMMENT_COMMANDS: readonly DocxCommandInfo<CommentCommand["type"]>[] = [
	// Word's Ctrl+Alt+M (Cmd+Option+A): the host opens the new comment's input.
	{
		type: "comment.add",
		labelKey: "docx.comment.add",
		icon: "comment-add",
		shortcut: "mod+alt+m",
		appleShortcut: "mod+alt+a",
		hostShortcut: true,
		write: true,
		author: true,
		input: "text",
		...document
	},
	{ type: "comment.reply", labelKey: "docx.comment.reply", icon: "comment-reply", write: true, author: true, input: "text", ...document },
	{ type: "comment.edit", labelKey: "docx.comment.edit", icon: "comment-edit", write: true, author: true, input: "text", ...document },
	{ type: "comment.resolve", labelKey: "docx.comment.resolve", icon: "comment-resolve", write: true, ...document },
	{ type: "comment.reopen", labelKey: "docx.comment.reopen", icon: "comment-reopen", write: true, ...document },
	{ type: "comment.delete", labelKey: "docx.comment.delete", icon: "comment-delete", write: true, ...document },
	{ type: "comment.next", labelKey: "docx.comment.next", icon: "comment-next", write: false, ...document },
	{ type: "comment.prev", labelKey: "docx.comment.prev", icon: "comment-prev", write: false, ...document }
]

export const parseCommentCommand: DocxCommandParser<CommentCommand> = (type, value) => {
	switch (type) {
		case "comment.add": {
			const text = stringArg(value, "text", MAX_COMMENT_TEXT)

			return text === undefined ? undefined : { type, text }
		}
		case "comment.reply":
		case "comment.edit": {
			const id = idArg(value, "id")
			const text = stringArg(value, "text", MAX_COMMENT_TEXT)

			return id === undefined || text === undefined ? undefined : { type, id, text }
		}
		case "comment.resolve":
		case "comment.reopen":
		case "comment.delete": {
			const id = idArg(value, "id")

			return id === undefined ? undefined : { type, id }
		}
		default:
			return { type }
	}
}
