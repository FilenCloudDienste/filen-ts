import { useTranslation } from "react-i18next"
import { FileTextIcon, XIcon } from "lucide-react"
import { driveItemName } from "@filen/shared"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { activeDocumentKey, useActiveDocument } from "@/lib/activeDocument"
import { noteDisplayTitle } from "@/features/notes/lib/displayTitle"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"

// Above the composer while a document is open: the next question is about it, unless the user removes it with ×
// (for that one question; the chip is back after it is sent).
export function AssistantDocumentChip() {
	const { t } = useTranslation("assistant")
	const { t: tNotes } = useTranslation(["notes", "common"])
	const open = useActiveDocument()
	const detached = useAssistantStore(state => state.detachedDocument)
	const setDetached = useAssistantStore(state => state.setDetachedDocument)

	if (open === null) {
		return null
	}

	const key = activeDocumentKey(open)

	if (key === detached) {
		return null
	}

	const { page, slide, sheet } = open.position
	const where =
		(open.kind === "pdf" || open.kind === "docx") && page !== undefined
			? t("assistantDocumentChipPage", { page })
			: open.kind === "slides" && slide !== undefined
				? t("assistantDocumentChipSlide", { slide })
				: open.kind === "sheet" && sheet !== undefined
					? sheet
					: null
	const name = "note" in open.item ? noteDisplayTitle(open.item.note, tNotes) : driveItemName(open.item)

	return (
		<div className="flex shrink-0 px-3 pt-2">
			<div
				role="status"
				className="flex max-w-full min-w-0 items-center gap-1.5 rounded-full border border-border bg-muted/60 py-0.5 pr-0.5 pl-2.5 text-xs text-muted-foreground"
			>
				<FileTextIcon
					aria-hidden="true"
					className="size-3.5 shrink-0"
				/>
				<span className="sr-only">{t("assistantDocumentChipLabel")}</span>
				<span className="min-w-0 truncate text-foreground">{name}</span>
				{where === null ? null : (
					<span className="shrink-0">
						<span aria-hidden="true">· </span>
						{where}
					</span>
				)}
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								aria-label={t("assistantDocumentChipRemove", { name })}
								className="flex size-5 shrink-0 items-center justify-center rounded-full focus-ring transition-colors outline-none hover:bg-background hover:text-foreground"
								onClick={() => {
									setDetached(key)
								}}
							>
								<XIcon
									aria-hidden="true"
									className="size-3"
								/>
							</button>
						}
					/>
					<TooltipContent>{t("assistantDocumentChipRemove", { name })}</TooltipContent>
				</Tooltip>
			</div>
		</div>
	)
}
