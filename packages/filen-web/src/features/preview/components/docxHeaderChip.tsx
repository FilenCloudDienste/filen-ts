import { useTranslation } from "react-i18next"
import { SettingsIcon, XIcon } from "lucide-react"
import type { DocxEditorCommand, DocxEditorCommandType, DocxEditorSnapshot } from "@filen/office/core/docx/edit"
import { useRef, useState } from "react"
import { COMMAND_LABELS, headerChipKey, keepFocus } from "@/features/preview/components/docxEditor.logic"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

// The floating chip while a header or footer is edited (Word's "Header — Close"): which one it is (its section
// once there are several), its toggles (different first page, different odd and even pages, link to previous,
// confirmed where it deletes the section's own), removing it, and Close (Esc in the document does the same).

type Header = NonNullable<DocxEditorSnapshot["context"]["story"]["header"]>

export interface DocxHeaderChipProps {
	header: Header
	enabled: DocxEditorSnapshot["enabled"]
	readOnly: boolean
	execute: (command: DocxEditorCommand) => void
	onClose: () => void
}

export function DocxHeaderChip({ header, enabled, readOnly, execute, onClose }: DocxHeaderChipProps) {
	const { t } = useTranslation(["preview", "common"])
	// Linking a section that has its own header deletes it: asked first, as Word asks.
	const [confirming, setConfirming] = useState(false)
	const options = useRef<HTMLButtonElement | null>(null)
	const toggles: readonly { type: DocxEditorCommandType; checked: boolean; shown: boolean }[] = [
		{ type: "header.differentFirst", checked: header.differentFirst, shown: true },
		{ type: "header.differentOddEven", checked: header.differentOddEven, shown: true },
		{ type: "header.linkToPrevious", checked: header.linkedToPrevious, shown: header.canLink }
	]
	const remove: DocxEditorCommandType = header.kind === "footer" ? "footer.remove" : "header.remove"
	const removeLabel = COMMAND_LABELS[remove]
	const labelled = toggles.filter(toggle => toggle.shown && COMMAND_LABELS[toggle.type] !== undefined)
	const name = t(headerChipKey(header), { section: header.section + 1 })

	return (
		<div
			role="group"
			aria-label={name}
			data-docx-header-chip=""
			className="pointer-events-auto absolute top-2 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-popover py-0.5 pr-0.5 pl-3 text-xs text-popover-foreground shadow-md"
		>
			<span className="font-medium whitespace-nowrap">{name}</span>
			{header.linkedToPrevious ? (
				<Badge
					variant="outline"
					className="max-sm:hidden"
				>
					{t("previewDocxHeaderSameAsPrevious")}
				</Badge>
			) : null}
			{labelled.length > 0 || removeLabel !== undefined ? (
				<DropdownMenu>
					<Tooltip>
						<TooltipTrigger
							render={
								<DropdownMenuTrigger
									render={
										<Button
											ref={options}
											variant="ghost"
											size="icon-xs"
											aria-label={t("previewDocxHeaderOptions")}
											onMouseDown={keepFocus}
										>
											<SettingsIcon />
										</Button>
									}
								/>
							}
						/>
						<TooltipContent>{t("previewDocxHeaderOptions")}</TooltipContent>
					</Tooltip>
					<DropdownMenuContent
						align="center"
						data-preview-surface
					>
						{labelled.map(toggle => {
							const label = COMMAND_LABELS[toggle.type]

							return label === undefined ? null : (
								<DropdownMenuCheckboxItem
									key={toggle.type}
									checked={toggle.checked}
									closeOnClick
									disabled={readOnly || !enabled[toggle.type]}
									onClick={() => {
										if (toggle.type === "header.linkToPrevious" && !header.linkedToPrevious) {
											setConfirming(true)
										} else {
											execute({ type: toggle.type } as DocxEditorCommand)
										}
									}}
								>
									{t(label)}
								</DropdownMenuCheckboxItem>
							)
						})}
						{removeLabel === undefined ? null : (
							<>
								{labelled.length > 0 ? <DropdownMenuSeparator /> : null}
								<DropdownMenuItem
									variant="destructive"
									disabled={readOnly || !enabled[remove]}
									onClick={() => {
										execute({ type: remove })
									}}
								>
									{t(removeLabel)}
								</DropdownMenuItem>
							</>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
			<Button
				variant="ghost"
				size="xs"
				aria-label={header.kind === "footer" ? t("previewDocxHeaderCloseFooter") : t("previewDocxHeaderCloseHeader")}
				className="rounded-full"
				onMouseDown={keepFocus}
				onClick={onClose}
			>
				<XIcon data-icon="inline-start" />
				{t("previewDocxHeaderClose")}
			</Button>
			<ConfirmDialog
				open={confirming}
				pending={false}
				destructive
				title={t("previewDocxHeaderLinkTitle")}
				body={header.kind === "footer" ? t("previewDocxFooterLinkBody") : t("previewDocxHeaderLinkBody")}
				// Back to the chip's options, where it was asked from.
				finalFocus={options}
				confirmLabel={t("previewDocxHeaderLinkConfirm")}
				cancelLabel={t("common:cancel")}
				onOpenChange={setConfirming}
				onConfirm={() => {
					setConfirming(false)
					execute({ type: "header.linkToPrevious" })
				}}
			/>
		</div>
	)
}
