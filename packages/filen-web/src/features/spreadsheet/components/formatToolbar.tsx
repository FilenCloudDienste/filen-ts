import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
	AlignCenterIcon,
	AlignLeftIcon,
	AlignRightIcon,
	BaselineIcon,
	BoldIcon,
	ItalicIcon,
	PaintBucketIcon,
	Redo2Icon,
	StrikethroughIcon,
	UnderlineIcon,
	Undo2Icon
} from "lucide-react"
import { cn } from "@filen/shared"
import type { FormatPatch } from "@/features/spreadsheet/lib/edits"
import type { CellStyleView } from "@/features/spreadsheet/lib/model"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { PreviewKey } from "@/lib/i18n"

// The number formats offered by name; any other a cell carries shows as "Custom".
const NUMBER_FORMATS: readonly { value: string; labelKey: PreviewKey }[] = [
	{ value: "General", labelKey: "previewSpreadsheetFormatGeneral" },
	{ value: "#,##0.00", labelKey: "previewSpreadsheetFormatNumber" },
	{ value: '"$"#,##0.00', labelKey: "previewSpreadsheetFormatDollar" },
	{ value: '#,##0.00 "€"', labelKey: "previewSpreadsheetFormatEuro" },
	{ value: "0.00%", labelKey: "previewSpreadsheetFormatPercent" },
	{ value: "yyyy-mm-dd", labelKey: "previewSpreadsheetFormatDate" },
	{ value: "@", labelKey: "previewSpreadsheetFormatText" }
]

const CUSTOM = "custom"

const PALETTE = [
	"#000000",
	"#595959",
	"#a6a6a6",
	"#ffffff",
	"#c00000",
	"#ff0000",
	"#ffc000",
	"#ffff00",
	"#92d050",
	"#00b050",
	"#00b0f0",
	"#0070c0",
	"#002060",
	"#7030a0",
	"#f4b183",
	"#c5e0b4"
]

function ToolbarButton({
	label,
	active,
	disabled,
	onClick,
	children
}: {
	label: string
	active?: boolean
	disabled?: boolean
	onClick: () => void
	children: ReactNode
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={label}
						aria-pressed={active}
						disabled={disabled}
						className={cn(active === true && "bg-accent text-foreground")}
						onClick={onClick}
					>
						{children}
					</Button>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	)
}

function ColorButton({
	label,
	icon,
	current,
	disabled,
	onPick
}: {
	label: string
	icon: ReactNode
	current: string | undefined
	disabled: boolean
	onPick: (color: string | null) => void
}) {
	const { t } = useTranslation("preview")

	return (
		<Popover>
			<Tooltip>
				<TooltipTrigger
					render={
						<PopoverTrigger
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={label}
									disabled={disabled}
									className="flex-col gap-0"
								>
									{icon}
									<span
										aria-hidden="true"
										className="h-0.5 w-3.5 rounded-full ring-1 ring-border"
										style={{ backgroundColor: current ?? "transparent" }}
									/>
								</Button>
							}
						/>
					}
				/>
				<TooltipContent>{label}</TooltipContent>
			</Tooltip>
			<PopoverContent
				data-preview-surface
				className="w-auto gap-2 p-3"
			>
				<div className="grid grid-cols-8 gap-1.5">
					{PALETTE.map(color => (
						<button
							key={color}
							type="button"
							aria-label={color}
							className="size-6 rounded-md focus-ring ring-1 ring-border"
							style={{ backgroundColor: color }}
							onClick={() => {
								onPick(color)
							}}
						/>
					))}
				</div>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => {
						onPick(null)
					}}
				>
					{t("previewSpreadsheetColorNone")}
				</Button>
			</PopoverContent>
		</Popover>
	)
}

// Undo and redo for every editable sheet; the formats too for a workbook (a CSV holds none). Shown
// `disabled` while editing waits to become possible, so the grid below does not move when it does.
export function FormatToolbar({
	disabled,
	style,
	formats,
	canUndo,
	canRedo,
	onUndo,
	onRedo,
	onFormat
}: {
	disabled: boolean
	style: CellStyleView | undefined
	formats: boolean
	canUndo: boolean
	canRedo: boolean
	onUndo: () => void
	onRedo: () => void
	onFormat: (patch: FormatPatch) => void
}) {
	const { t } = useTranslation("preview")
	const numFmt = style?.numFmt ?? "General"
	const formatValue = NUMBER_FORMATS.some(format => format.value === numFmt) ? numFmt : CUSTOM

	return (
		<div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-2">
			<ToolbarButton
				label={t("previewSpreadsheetUndo")}
				disabled={disabled || !canUndo}
				onClick={onUndo}
			>
				<Undo2Icon />
			</ToolbarButton>
			<ToolbarButton
				label={t("previewSpreadsheetRedo")}
				disabled={disabled || !canRedo}
				onClick={onRedo}
			>
				<Redo2Icon />
			</ToolbarButton>
			{formats ? (
				<>
					<span
						aria-hidden="true"
						className="mx-1 h-5 w-px bg-border"
					/>
					<ToolbarButton
						label={t("previewSpreadsheetBold")}
						disabled={disabled}
						active={style?.bold === true}
						onClick={() => {
							onFormat({ bold: style?.bold !== true })
						}}
					>
						<BoldIcon />
					</ToolbarButton>
					<ToolbarButton
						label={t("previewSpreadsheetItalic")}
						disabled={disabled}
						active={style?.italic === true}
						onClick={() => {
							onFormat({ italic: style?.italic !== true })
						}}
					>
						<ItalicIcon />
					</ToolbarButton>
					<ToolbarButton
						label={t("previewSpreadsheetUnderline")}
						disabled={disabled}
						active={style?.underline === true}
						onClick={() => {
							onFormat({ underline: style?.underline !== true })
						}}
					>
						<UnderlineIcon />
					</ToolbarButton>
					<ToolbarButton
						label={t("previewSpreadsheetStrikethrough")}
						disabled={disabled}
						active={style?.strike === true}
						onClick={() => {
							onFormat({ strike: style?.strike !== true })
						}}
					>
						<StrikethroughIcon />
					</ToolbarButton>
					<span
						aria-hidden="true"
						className="mx-1 h-5 w-px bg-border"
					/>
					<ColorButton
						label={t("previewSpreadsheetTextColor")}
						disabled={disabled}
						icon={<BaselineIcon />}
						current={style?.color}
						onPick={color => {
							onFormat({ color })
						}}
					/>
					<ColorButton
						label={t("previewSpreadsheetFillColor")}
						disabled={disabled}
						icon={<PaintBucketIcon />}
						current={style?.fill}
						onPick={fill => {
							onFormat({ fill })
						}}
					/>
					<span
						aria-hidden="true"
						className="mx-1 h-5 w-px bg-border"
					/>
					<ToolbarButton
						label={t("previewSpreadsheetAlignLeft")}
						disabled={disabled}
						active={style?.align === "left"}
						onClick={() => {
							onFormat({ align: style?.align === "left" ? null : "left" })
						}}
					>
						<AlignLeftIcon />
					</ToolbarButton>
					<ToolbarButton
						label={t("previewSpreadsheetAlignCenter")}
						disabled={disabled}
						active={style?.align === "center"}
						onClick={() => {
							onFormat({ align: style?.align === "center" ? null : "center" })
						}}
					>
						<AlignCenterIcon />
					</ToolbarButton>
					<ToolbarButton
						label={t("previewSpreadsheetAlignRight")}
						disabled={disabled}
						active={style?.align === "right"}
						onClick={() => {
							onFormat({ align: style?.align === "right" ? null : "right" })
						}}
					>
						<AlignRightIcon />
					</ToolbarButton>
					<span
						aria-hidden="true"
						className="mx-1 h-5 w-px bg-border"
					/>
					<Select
						items={[
							...NUMBER_FORMATS.map(format => ({ value: format.value, label: t(format.labelKey) })),
							{ value: CUSTOM, label: t("previewSpreadsheetFormatCustom") }
						]}
						value={formatValue}
						disabled={disabled}
						onValueChange={value => {
							if (value !== null && value !== CUSTOM) {
								onFormat({ numFmt: value })
							}
						}}
					>
						<SelectTrigger
							size="sm"
							aria-label={t("previewSpreadsheetNumberFormat")}
							className="w-36"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent data-preview-surface>
							<SelectGroup>
								{NUMBER_FORMATS.map(format => (
									<SelectItem
										key={format.value}
										value={format.value}
									>
										{t(format.labelKey)}
									</SelectItem>
								))}
								{formatValue === CUSTOM ? (
									<SelectItem value={CUSTOM}>{t("previewSpreadsheetFormatCustom")}</SelectItem>
								) : null}
							</SelectGroup>
						</SelectContent>
					</Select>
				</>
			) : null}
		</div>
	)
}
