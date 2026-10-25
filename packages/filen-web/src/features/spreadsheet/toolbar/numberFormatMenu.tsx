import { useTranslation } from "react-i18next"
import { ChevronDownIcon } from "lucide-react"
import { formatValue } from "@filen/office/core/sheet"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { NUMBER_ITEMS, numberLabel } from "@/features/spreadsheet/toolbar/toolbar.logic"

// The Number Format dropdown: Excel's Home tab list, each item showing the active cell's value in it (when the cell
// holds a number), then "More number formats…" (the Format Cells dialog).

// What a number shows in a code, for a menu item's hint.
function sampleText(sample: number | null, code: string, date1904: boolean): string {
	return sample === null ? "" : formatValue(sample, code, { date1904 }).text
}

function NumberFormatItems({
	numFmt,
	sample,
	date1904,
	onFormat,
	onMore
}: {
	numFmt: string
	sample: number | null
	date1904: boolean
	onFormat: (code: string) => void
	onMore: () => void
}) {
	const { t } = useTranslation("preview")

	return (
		<>
			<DropdownMenuRadioGroup
				value={NUMBER_ITEMS.some(item => item.code === numFmt) ? numFmt : ""}
				onValueChange={(code: string) => {
					onFormat(code)
				}}
			>
				{NUMBER_ITEMS.map(item => (
					<DropdownMenuRadioItem
						key={item.code}
						value={item.code}
						closeOnClick
					>
						<span className="flex min-w-48 flex-1 items-center justify-between gap-4">
							<span>{t(item.label)}</span>
							<span className="max-w-32 truncate text-xs text-muted-foreground tabular-nums">
								{sampleText(sample, item.code, date1904)}
							</span>
						</span>
					</DropdownMenuRadioItem>
				))}
			</DropdownMenuRadioGroup>
			<DropdownMenuSeparator />
			<DropdownMenuItem onClick={onMore}>{t("previewSheetNumberMore")}</DropdownMenuItem>
		</>
	)
}

export function NumberFormatMenu({
	numFmt,
	sample,
	date1904,
	disabled,
	onFormat,
	onMore
}: {
	numFmt: string
	sample: number | null
	date1904: boolean
	disabled: boolean
	onFormat: (code: string) => void
	onMore: () => void
}) {
	const { t } = useTranslation("preview")

	return (
		<DropdownMenu>
			<Tooltip>
				<TooltipTrigger
					render={
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="sm"
									disabled={disabled}
									aria-label={t("previewSpreadsheetNumberFormat")}
									className="w-28 shrink-0 justify-between gap-0.5 px-2"
								>
									<span className="truncate">{t(numberLabel(numFmt))}</span>
									<ChevronDownIcon className="size-3" />
								</Button>
							}
						/>
					}
				/>
				<TooltipContent>{t("previewSpreadsheetNumberFormat")}</TooltipContent>
			</Tooltip>
			<DropdownMenuContent data-preview-surface>
				<NumberFormatItems
					numFmt={numFmt}
					sample={sample}
					date1904={date1904}
					onFormat={onFormat}
					onMore={onMore}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
