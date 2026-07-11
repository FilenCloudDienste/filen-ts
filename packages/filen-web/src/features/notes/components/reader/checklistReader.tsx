import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { checklistRows } from "@/features/notes/components/reader/checklistReader.logic"

// checklist note render — disabled checkboxes, checked state faithful to the parsed
// `<ul data-checked>` HTML (@filen/utils checklistParser, the canonical cross-client format).
// Read-only this step: the custom editable widget (mobile-style, per 01-DECISIONS D2) lands with the
// sync outbox next wave.
export function ChecklistReader({ content }: { content: string }) {
	const { t } = useTranslation("notes")
	const rows = checklistRows(content)

	if (rows.length === 0) {
		return (
			<div className="flex size-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
				{t("noteChecklistEmpty")}
			</div>
		)
	}

	return (
		<div className="flex size-full flex-col gap-0.5 overflow-auto p-4">
			{rows.map(item => (
				<label
					key={item.id}
					className="flex items-start gap-2.5 rounded-md px-2 py-1.5 text-sm"
				>
					<input
						type="checkbox"
						checked={item.checked}
						disabled
						className="mt-0.5 size-4 shrink-0 rounded border-input accent-primary"
					/>
					<span className={cn("leading-6 break-words", item.checked && "text-muted-foreground line-through")}>
						{item.content}
					</span>
				</label>
			))}
		</div>
	)
}
