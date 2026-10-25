import { useTranslation } from "react-i18next"
import {
	AlignCenterIcon,
	AlignJustifyIcon,
	AlignLeftIcon,
	AlignRightIcon,
	AlignVerticalJustifyCenterIcon,
	AlignVerticalJustifyEndIcon,
	AlignVerticalJustifyStartIcon,
	ChevronDownIcon,
	type LucideIcon
} from "lucide-react"
import type { SheetHorizontalAlign, SheetVerticalAlign } from "@filen/office/core/sheet"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { HORIZONTAL_ALIGNS, VERTICAL_ALIGNS } from "@/features/spreadsheet/toolbar/toolbar.logic"

// The alignment dropdowns: every horizontal alignment ECMA-376 names (§18.18.40) and every vertical one (§18.18.88),
// each trigger showing the alignment in effect.

type Horizontal = SheetHorizontalAlign | "general"

function horizontalIcon(align: Horizontal): LucideIcon {
	switch (align) {
		case "center":
		case "centerContinuous":
			return AlignCenterIcon
		case "right":
			return AlignRightIcon
		case "justify":
		case "distributed":
		case "fill":
			return AlignJustifyIcon
		default:
			return AlignLeftIcon
	}
}

function verticalIcon(valign: SheetVerticalAlign): LucideIcon {
	return valign === "top"
		? AlignVerticalJustifyStartIcon
		: valign === "bottom"
			? AlignVerticalJustifyEndIcon
			: AlignVerticalJustifyCenterIcon
}

function Trigger({ label, icon: Icon, disabled }: { label: string; icon: LucideIcon; disabled: boolean }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<DropdownMenuTrigger
						render={
							<Button
								variant="ghost"
								size="sm"
								disabled={disabled}
								aria-label={label}
								className="shrink-0 gap-0.5 px-1.5"
							>
								<Icon />
								<ChevronDownIcon className="size-3" />
							</Button>
						}
					/>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	)
}

function HorizontalAlignItems({ align, onAlign }: { align: Horizontal; onAlign: (align: Horizontal) => void }) {
	const { t } = useTranslation("preview")

	return (
		<DropdownMenuRadioGroup
			value={align}
			onValueChange={(next: Horizontal) => {
				onAlign(next)
			}}
		>
			{HORIZONTAL_ALIGNS.map(entry => {
				const Icon = horizontalIcon(entry.align)

				return (
					<DropdownMenuRadioItem
						key={entry.align}
						value={entry.align}
						closeOnClick
					>
						<Icon />
						{t(entry.label)}
					</DropdownMenuRadioItem>
				)
			})}
		</DropdownMenuRadioGroup>
	)
}

function VerticalAlignItems({ valign, onValign }: { valign: SheetVerticalAlign; onValign: (valign: SheetVerticalAlign) => void }) {
	const { t } = useTranslation("preview")

	return (
		<DropdownMenuRadioGroup
			value={valign}
			onValueChange={(next: SheetVerticalAlign) => {
				onValign(next)
			}}
		>
			{VERTICAL_ALIGNS.map(entry => {
				const Icon = verticalIcon(entry.valign)

				return (
					<DropdownMenuRadioItem
						key={entry.valign}
						value={entry.valign}
						closeOnClick
					>
						<Icon />
						{t(entry.label)}
					</DropdownMenuRadioItem>
				)
			})}
		</DropdownMenuRadioGroup>
	)
}

export function HorizontalAlignMenu({
	align,
	disabled,
	onAlign
}: {
	align: Horizontal
	disabled: boolean
	onAlign: (align: Horizontal) => void
}) {
	const { t } = useTranslation("preview")

	return (
		<DropdownMenu>
			<Trigger
				label={t("previewSheetFormatHorizontalAlign")}
				icon={horizontalIcon(align)}
				disabled={disabled}
			/>
			<DropdownMenuContent data-preview-surface>
				<HorizontalAlignItems
					align={align}
					onAlign={onAlign}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

export function VerticalAlignMenu({
	valign,
	disabled,
	onValign
}: {
	valign: SheetVerticalAlign
	disabled: boolean
	onValign: (valign: SheetVerticalAlign) => void
}) {
	const { t } = useTranslation("preview")

	return (
		<DropdownMenu>
			<Trigger
				label={t("previewSheetFormatVerticalAlign")}
				icon={verticalIcon(valign)}
				disabled={disabled}
			/>
			<DropdownMenuContent data-preview-surface>
				<VerticalAlignItems
					valign={valign}
					onValign={onValign}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
