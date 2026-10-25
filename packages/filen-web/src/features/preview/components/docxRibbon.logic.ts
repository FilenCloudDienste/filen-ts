import {
	parseDocxEditorCommand,
	type DocxEditorCommand,
	type DocxEditorCommandType,
	type DocxEditorSnapshot
} from "@filen/office/core/docx/edit"
import { commandVariants, type DocxToolbarCommand, type DocxToolbarSlotProps } from "@/features/preview/components/docxEditor.logic"
import type { PreviewKey } from "@/lib/i18n"

// What the Word ribbon's command controls (docxRibbonControls.tsx) decide: whether a tab offers a command, whether it
// is off, and the entries of a dropdown of commands.

export type DocxCommandProps = Pick<DocxToolbarSlotProps, "commands" | "snapshot" | "readOnly" | "execute" | "requestInput">

export function slotCommand(commands: readonly DocxToolbarCommand[], type: DocxEditorCommandType): DocxToolbarCommand | undefined {
	return commands.find(command => command.info.type === type)
}

// Off: not offered, no session yet, a write while read-only, or the session says so.
export function commandOff(
	commands: readonly DocxToolbarCommand[],
	snapshot: DocxEditorSnapshot | undefined,
	readOnly: boolean,
	type: DocxEditorCommandType
): boolean {
	const command = slotCommand(commands, type)

	return command === undefined || snapshot === undefined || (readOnly && command.info.write) || !snapshot.enabled[type]
}

export interface DocxMenuEntry {
	readonly label: string
	// A command to run, or the input to ask for.
	readonly command?: DocxEditorCommand
	readonly input?: { readonly type: DocxEditorCommandType; readonly detail?: string }
	readonly disabled?: boolean | undefined
}

// A labelled command without arguments as a menu entry, or none when the tab does not offer it.
export function commandEntry(props: DocxCommandProps, type: DocxEditorCommandType, t: (key: PreviewKey) => string): DocxMenuEntry[] {
	const command = slotCommand(props.commands, type)
	const parsed = parseDocxEditorCommand({ type })

	return command === undefined || parsed === undefined
		? []
		: [{ label: t(command.label), disabled: commandOff(props.commands, props.snapshot, props.readOnly, type), command: parsed }]
}

// A command offered in several forms (Form control ▸ Checkbox, Breaks ▸ Section break: Next page), as entries.
export function variantEntries(
	props: DocxCommandProps,
	type: "control.insert" | "insert.sectionBreak",
	t: (key: PreviewKey) => string
): DocxMenuEntry[] {
	const variants = commandVariants(type)

	if (slotCommand(props.commands, type) === undefined || variants === undefined) {
		return []
	}

	const disabled = commandOff(props.commands, props.snapshot, props.readOnly, type)

	return variants.map(variant => ({
		label: t(variant.label),
		disabled,
		...("command" in variant ? { command: variant.command } : { input: { type, detail: variant.input } })
	}))
}
