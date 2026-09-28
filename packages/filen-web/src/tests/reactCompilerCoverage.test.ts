import { describe, expect, it } from "vitest"
import { transformFileSync } from "@babel/core"

// The React Compiler silently skips a hook or component it can't compile, and neither lint nor
// check:compiler (a fixture probe) notices. These files are compiled the way vite.config.ts compiles
// them and must come out compiled.

interface CompilerEvent {
	kind: string
	fnName: string | null
	memoSlots?: number
}

function compile(file: string): CompilerEvent[] {
	const events: CompilerEvent[] = []

	transformFileSync(file, {
		babelrc: false,
		configFile: false,
		presets: ["@babel/preset-typescript"],
		plugins: [
			// @rolldown/plugin-babel parses a .tsx file's JSX itself; a bare transform needs the syntax plugin.
			...(file.endsWith(".tsx") ? ["@babel/plugin-syntax-jsx"] : []),
			[
				"babel-plugin-react-compiler",
				{
					logger: {
						logEvent: (_filename: string | null, event: CompilerEvent) => {
							events.push(event)
						}
					}
				}
			]
		]
	})

	return events
}

describe("React Compiler coverage", () => {
	it("compiles useDriveDropTarget, which every directory row, tile, tree node and crumb runs", () => {
		const events = compile("src/features/drive/hooks/useDriveDropTarget.ts")

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(
			events.some(event => event.kind === "CompileSuccess" && event.fnName === "useDriveDropTarget" && (event.memoSlots ?? 0) > 0)
		).toBe(true)
	})

	it("compiles useDriveClipboard, which every drive listing runs", () => {
		const events = compile("src/features/drive/hooks/useDriveClipboard.ts")

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(
			events.some(event => event.kind === "CompileSuccess" && event.fnName === "useDriveClipboard" && (event.memoSlots ?? 0) > 0)
		).toBe(true)
	})

	// A destructuring default is what the compiler cannot lower; each of these had one.
	it.each([
		["src/features/drive/components/newDirectory.tsx", "NewDirectory"],
		["src/features/drive/components/moveTargetDialog.tsx", "MoveTargetDialog"],
		["src/features/drive/hooks/useUploadMenuActions.tsx", "useUploadMenuActions"],
		["src/components/ui/alert-dialog.tsx", "AlertDialogContent"],
		["src/components/ui/alert-dialog.tsx", "AlertDialogCancel"],
		["src/components/ui/avatar.tsx", "Avatar"],
		["src/components/ui/badge.tsx", "Badge"],
		["src/components/ui/button.tsx", "Button"],
		["src/components/ui/card.tsx", "Card"],
		["src/components/ui/context-menu.tsx", "ContextMenuContent"],
		["src/components/ui/context-menu.tsx", "ContextMenuItem"],
		["src/components/ui/dialog.tsx", "DialogContent"],
		["src/components/ui/dialog.tsx", "DialogFooter"],
		["src/components/ui/dropdown-menu.tsx", "DropdownMenuContent"],
		["src/components/ui/dropdown-menu.tsx", "DropdownMenuItem"],
		["src/components/ui/dropdown-menu.tsx", "DropdownMenuSubContent"],
		["src/components/ui/empty.tsx", "EmptyMedia"],
		["src/components/ui/field.tsx", "FieldLegend"],
		["src/components/ui/field.tsx", "Field"],
		["src/components/ui/popover.tsx", "PopoverContent"],
		["src/components/ui/select.tsx", "SelectTrigger"],
		["src/components/ui/select.tsx", "SelectContent"],
		["src/components/ui/separator.tsx", "Separator"],
		["src/components/ui/switch.tsx", "Switch"],
		["src/components/ui/tooltip.tsx", "TooltipProvider"],
		["src/components/ui/tooltip.tsx", "TooltipContent"],
		["src/providers/themeProvider.tsx", "ThemeProvider"],
		["src/components/dialogs/confirmDialog.tsx", "ConfirmDialog"],
		["src/components/dialogs/typedConfirmDialog.tsx", "TypedConfirmDialog"],
		["src/features/publicLinks/components/saveToDrive.tsx", "SaveToDriveButton"],
		["src/features/drive/components/destinationMenu.tsx", "DestinationEntries"],
		["src/features/drive/components/uploadMenu.tsx", "UploadMenu"],
		["src/features/drive/components/uploadMenu.tsx", "UploadContextMenu"],
		["src/features/drive/components/sortMenu.tsx", "SortMenu"],
		["src/features/drive/components/uploadDropzone.tsx", "UploadDropzone"],
		["src/features/contacts/components/addContactDialog.tsx", "AddContactDialog"],
		["src/features/notes/components/markdownSplitPane.tsx", "MarkdownSplitPane"],
		["src/features/notes/components/noteContentBody.tsx", "NoteContentBody"],
		["src/features/notes/components/editor/checklistEditor.tsx", "ChecklistEditor"],
		["src/features/chats/components/thread/chatsPlaceholder.tsx", "ChatsPlaceholder"]
	])("compiles %s", (file, fnName) => {
		const events = compile(file)

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(true)
	})
})
