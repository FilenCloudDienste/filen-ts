import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { CircleCheckIcon, CircleXIcon, EyeIcon, FileDiffIcon, MessageSquarePlusIcon } from "lucide-react"
import { isWriteCommand, type DocxEditorCommandType } from "@filen/office/core/docx/edit"
import { DOCX_MARKUP_MODES, type DocxMarkupMode } from "@filen/office/dom/docx"
import type { DocxToolbarSlotProps } from "@/features/preview/components/docxEditor.logic"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import { DocxCommandMenu } from "@/features/preview/components/docxRibbonControls"
import type { DocxMenuEntry } from "@/features/preview/components/docxRibbon.logic"
import { MARKUP_LABELS } from "@/features/preview/components/docxViewer.logic"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu"

// The Word ribbon's Review tab controls (docxRibbonGroups.tsx places them): comments (a new one, stepping through
// them), tracking (the track changes switch, the markup shown) and changes (stepping through them, accepting or
// rejecting the one at the caret or all).

// Off: no session, not labelled, or a write the document cannot take now.
function reviewOff(props: DocxToolbarSlotProps, type: DocxEditorCommandType): boolean {
	const { snapshot } = props

	return (
		snapshot === undefined ||
		!props.commands.some(command => command.info.type === type) ||
		!snapshot.enabled[type] ||
		((props.readOnly || snapshot.readOnly) && isWriteCommand(type))
	)
}

function labelOf(props: DocxToolbarSlotProps, type: DocxEditorCommandType) {
	return props.commands.find(command => command.info.type === type)?.label
}

export function StepButton({
	type,
	icon,
	...props
}: DocxToolbarSlotProps & { type: "comment.prev" | "comment.next" | "review.prev" | "review.next"; icon: ReactNode }) {
	const { t } = useTranslation("preview")
	const label = labelOf(props, type)

	return label === undefined ? null : (
		<RibbonButton
			label={t(label)}
			icon={icon}
			disabled={reviewOff(props, type)}
			onClick={() => {
				props.execute({ type })
			}}
		/>
	)
}

export function MarkupMenu({ markup, onMarkupChange }: { markup: DocxMarkupMode; onMarkupChange: (mode: DocxMarkupMode) => void }) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t("previewDocxMarkup")}
				icon={<EyeIcon />}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
			>
				<DropdownMenuRadioGroup
					value={markup}
					onValueChange={(mode: DocxMarkupMode) => {
						onMarkupChange(mode)
						focus.ran()
					}}
				>
					{DOCX_MARKUP_MODES.map(info => (
						<DropdownMenuRadioItem
							key={info.mode}
							value={info.mode}
							closeOnClick
						>
							{t(MARKUP_LABELS[info.mode])}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// Accept ▾ or Reject ▾: the change at the caret, or every change.
export function DecideMenu({ accept, ...props }: DocxToolbarSlotProps & { accept: boolean }) {
	const { t } = useTranslation("preview")
	const one = accept ? ("review.accept" as const) : ("review.reject" as const)
	const all = accept ? ("review.acceptAll" as const) : ("review.rejectAll" as const)
	const entries: DocxMenuEntry[] = []
	const oneLabel = labelOf(props, one)
	const allLabel = labelOf(props, all)

	if (oneLabel !== undefined) {
		entries.push({
			label: t(oneLabel),
			// Needs a change at the caret.
			disabled: reviewOff(props, one) || props.snapshot?.review.current == null,
			command: { type: one }
		})
	}

	if (allLabel !== undefined) {
		entries.push({ label: t(allLabel), disabled: reviewOff(props, all), command: { type: all } })
	}

	return entries.length === 0 ? null : (
		<DocxCommandMenu
			label={t(accept ? "previewDocxRibbonAccept" : "previewDocxRibbonReject")}
			icon={accept ? <CircleCheckIcon /> : <CircleXIcon />}
			text={t(accept ? "previewDocxRibbonAccept" : "previewDocxRibbonReject")}
			entries={entries}
			execute={props.execute}
			requestInput={props.requestInput}
		/>
	)
}

// New comment, at the selection.
export function NewCommentButton(props: DocxToolbarSlotProps) {
	const { t } = useTranslation("preview")
	const label = labelOf(props, "comment.add")

	return label === undefined ? null : (
		<RibbonButton
			label={t(label)}
			icon={<MessageSquarePlusIcon />}
			text={t(label)}
			disabled={reviewOff(props, "comment.add")}
			onClick={() => {
				props.requestInput("comment.add")
			}}
		/>
	)
}

// The track changes switch.
export function TrackChangesButton(props: DocxToolbarSlotProps) {
	const { t } = useTranslation("preview")
	const label = labelOf(props, "review.track")
	const tracking = props.snapshot?.review.tracking === true

	return label === undefined ? null : (
		<RibbonButton
			label={t(label)}
			icon={<FileDiffIcon />}
			text={t(label)}
			pressed={tracking}
			disabled={reviewOff(props, "review.track")}
			onClick={() => {
				props.execute({ type: "review.track", on: !tracking })
			}}
		/>
	)
}
