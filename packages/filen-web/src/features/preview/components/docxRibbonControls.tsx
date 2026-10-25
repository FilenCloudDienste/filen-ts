import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { parseDocxEditorCommand, type DocxEditorCommand, type DocxEditorCommandType } from "@filen/office/core/docx/edit"
import type { DocxToolbarSlotProps } from "@/features/preview/components/docxEditor.logic"
import { commandOff, slotCommand, type DocxCommandProps, type DocxMenuEntry } from "@/features/preview/components/docxRibbon.logic"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"

// The Word ribbon's command controls: a button running a command or asking for its input, and a dropdown of
// commands. Each is shown once its command is labelled (offered by the tab's slot) and is off while the session
// says so or the document cannot change.

export function DocxCommandButton({
	type,
	icon,
	text,
	input,
	detail,
	...props
}: DocxCommandProps & {
	type: DocxEditorCommandType
	icon: ReactNode
	// The command's name shown beside its icon.
	text?: boolean
	// Asks for the command's input rather than running it.
	input?: boolean
	detail?: string
}) {
	const { t } = useTranslation("preview")
	const command = slotCommand(props.commands, type)

	if (command === undefined) {
		return null
	}

	const label = t(command.label)

	return (
		<RibbonButton
			label={label}
			icon={icon}
			text={text === true ? label : undefined}
			disabled={commandOff(props.commands, props.snapshot, props.readOnly, type)}
			onClick={() => {
				if (input === true) {
					props.requestInput(type, detail)

					return
				}

				const parsed = parseDocxEditorCommand({ type })

				if (parsed !== undefined) {
					props.execute(parsed)
				}
			}}
		/>
	)
}

// A dropdown of commands (Breaks, Accept, Delete): focus goes back to the document once one ran.
export function DocxCommandMenu({
	label,
	icon,
	text,
	disabled,
	entries,
	execute,
	requestInput,
	children
}: {
	label: string
	icon: ReactNode
	text?: string | undefined
	disabled?: boolean | undefined
	entries: readonly DocxMenuEntry[]
	execute: (command: DocxEditorCommand) => void
	requestInput: DocxToolbarSlotProps["requestInput"]
	// Content after the entries (a grid, a submenu).
	children?: ReactNode
}) {
	const focus = useCommandMenuFocus()

	return (
		<DropdownMenu
			onOpenChange={focus.opened}
			onOpenChangeComplete={focus.closed}
		>
			<RibbonMenuTrigger
				label={label}
				icon={icon}
				text={text}
				disabled={
					disabled === true || (entries.length > 0 && entries.every(entry => entry.disabled === true) && children === undefined)
				}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
			>
				{entries.map(entry => (
					<DropdownMenuItem
						key={entry.label}
						disabled={entry.disabled}
						onClick={() => {
							if (entry.command !== undefined) {
								execute(entry.command)
								focus.ran()
							} else if (entry.input !== undefined) {
								requestInput(entry.input.type, entry.input.detail)
								focus.kept()
							}
						}}
					>
						{entry.label}
					</DropdownMenuItem>
				))}
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
