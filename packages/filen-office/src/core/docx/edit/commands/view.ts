import { boolArg, type DocxCommandInfo, type DocxCommandParser } from "./base"

// How the document is shown. The surface is the app's state; the command is listed so every app labels it
// alike. Field codes are the editor's view (Word's View option, kept per window and never in the file): every
// field as its code instead of its result (Alt+F9), or the fields of the selection switched (Shift+F9).
// Formatting marks are Word's Show/Hide ¶ (Ctrl+Shift+8, Cmd+8 in Word for Mac): drawn over the pages, hidden text
// laid out, never saved.

export type ViewCommand =
	| { readonly type: "view.reflow"; readonly on: boolean }
	| { readonly type: "view.fieldCodes" }
	| { readonly type: "view.fieldCode" }
	| { readonly type: "view.formattingMarks" }

export const VIEW_COMMANDS: readonly DocxCommandInfo<ViewCommand["type"]>[] = [
	{ type: "view.reflow", labelKey: "docx.view.reflow", icon: "reflow", write: false, scope: "document", group: "view" },
	{
		type: "view.fieldCodes",
		labelKey: "docx.view.fieldCodes",
		icon: "field-codes",
		shortcut: "alt+F9",
		write: false,
		scope: "document",
		group: "view"
	},
	{
		type: "view.fieldCode",
		labelKey: "docx.view.fieldCode",
		icon: "field-code",
		shortcut: "shift+F9",
		write: false,
		scope: "document",
		group: "view"
	},
	{
		type: "view.formattingMarks",
		labelKey: "docx.view.formattingMarks",
		icon: "pilcrow",
		shortcut: "mod+shift+8",
		appleShortcut: "mod+8",
		write: false,
		scope: "document",
		group: "view"
	}
]

export const parseViewCommand: DocxCommandParser<ViewCommand> = (type, value) => {
	if (type !== "view.reflow") return { type }

	const on = boolArg(value, "on")

	return on === undefined ? undefined : { type, on }
}
