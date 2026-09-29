import { useTranslation } from "react-i18next"
import { PlusIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"

// The workbook's sheets as tabs along the bottom edge, the way spreadsheets show them. Arrow keys move
// between them (roving tabindex), as in a tablist. When editable, a sheet can be added, and renamed by
// double-clicking its tab (or F2 on it).
export function SheetTabs({
	sheets,
	active,
	onSelect,
	onAdd,
	onRename
}: {
	sheets: readonly { name: string }[]
	active: number
	onSelect: (index: number) => void
	onAdd?: (() => void) | undefined
	onRename?: ((index: number) => void) | undefined
}) {
	const { t } = useTranslation("preview")

	return (
		<div className="flex h-9 shrink-0 items-center gap-1 border-t border-border bg-muted/40 px-2">
			{onAdd !== undefined ? (
				<TooltipIconButton
					label={t("previewSpreadsheetAddSheet")}
					onClick={onAdd}
				>
					<PlusIcon />
				</TooltipIconButton>
			) : null}
			<div
				role="tablist"
				aria-label={t("previewSpreadsheetSheets")}
				className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
				onKeyDown={event => {
					if (event.key === "F2" && onRename !== undefined) {
						event.preventDefault()
						onRename(active)

						return
					}

					if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
						return
					}

					event.preventDefault()

					const next = (active + (event.key === "ArrowRight" ? 1 : -1) + sheets.length) % sheets.length

					onSelect(next)
					event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus()
				}}
			>
				{sheets.map((sheet, index) => (
					<button
						key={`${String(index)}:${sheet.name}`}
						type="button"
						role="tab"
						aria-selected={index === active}
						tabIndex={index === active ? 0 : -1}
						className={cn(
							"h-7 shrink-0 rounded-md px-3 text-xs whitespace-nowrap focus-ring transition-colors",
							index === active
								? "bg-background font-medium text-foreground shadow-sm ring-1 ring-border"
								: "text-muted-foreground hover:bg-accent/60"
						)}
						onClick={() => {
							onSelect(index)
						}}
						onDoubleClick={() => {
							onRename?.(index)
						}}
					>
						{sheet.name}
					</button>
				))}
			</div>
		</div>
	)
}
