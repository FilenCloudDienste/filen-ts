import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { CopyIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { copyText } from "@/lib/copyText"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import type { MetadataField, MetadataSectionData, MetadataTableData } from "@/features/preview/lib/metadataCard.types"

// A field's value as the page draws it; undefined keeps the default text.
export type MetadataValueRenderer = (field: MetadataField) => ReactNode

const ROW_HEIGHT = 32
// The table scrolls inside the card past this many rows.
const VISIBLE_ROWS = 12
const OVERSCAN = 8

function FieldValue({ field, renderValue }: { field: MetadataField; renderValue: MetadataValueRenderer | undefined }) {
	const custom = renderValue?.(field)

	if (custom !== undefined) {
		return custom
	}

	return <span className={field.mono === true ? "font-mono text-xs break-all" : "break-words whitespace-pre-line"}>{field.value}</span>
}

function FieldRow({ field, renderValue }: { field: MetadataField; renderValue: MetadataValueRenderer | undefined }) {
	const { t } = useTranslation("preview")
	const { copy } = field

	return (
		<div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3.5 py-2.5 text-sm">
			<dt className="shrink-0 text-muted-foreground">{field.label}</dt>
			<dd className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
				<span className="min-w-0 text-end font-medium select-text">
					<FieldValue
						field={field}
						renderValue={renderValue}
					/>
				</span>
				{copy === undefined ? null : (
					<TooltipIconButton
						label={t("previewMetadataCopy", { field: field.label })}
						className="-my-1 shrink-0 text-muted-foreground"
						onClick={() => {
							void copyText(copy, t("previewMetadataCopied"))
						}}
					>
						<CopyIcon />
					</TooltipIconButton>
				)}
			</dd>
		</div>
	)
}

function SectionTitle({ children }: { children: ReactNode }) {
	return <h3 className="px-1 text-xs font-medium text-muted-foreground">{children}</h3>
}

function MetadataSection({ section, renderValue }: { section: MetadataSectionData; renderValue: MetadataValueRenderer | undefined }) {
	return (
		<section className="flex min-w-0 flex-col gap-1.5">
			{section.title === undefined ? null : <SectionTitle>{section.title}</SectionTitle>}
			<dl className="flex min-w-0 flex-col divide-y divide-border/50 rounded-xl ring-1 ring-border/60">
				{section.fields.map((field, index) => (
					<FieldRow
						// Labels may repeat (several trackers, several emails); the order is the data's.
						key={index}
						field={field}
						renderValue={renderValue}
					/>
				))}
			</dl>
		</section>
	)
}

// The first column takes the spare width; the rest share what is left. Fixed fractions, not content widths: a
// virtualized row cannot see the widths of rows that are not mounted.
function columnTemplate(columns: number): string {
	return columns <= 1 ? "minmax(0, 1fr)" : `minmax(0, 2fr) repeat(${String(columns - 1)}, minmax(0, 1fr))`
}

// Only the rows in view are mounted, so a torrent's hundred thousand files cost a screenful of nodes.
function MetadataTable({ table }: { table: MetadataTableData }) {
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const virtualizer = useVirtualizer({
		count: table.rows.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => ROW_HEIGHT,
		overscan: OVERSCAN
	})
	const gridTemplateColumns = columnTemplate(table.columns.length)
	const alignClass = (index: number): string => (table.columns[index]?.align === "end" ? "text-end tabular-nums" : "text-start")

	return (
		<section className="flex min-w-0 flex-col gap-1.5">
			<SectionTitle>{table.label}</SectionTitle>
			<div
				role="table"
				aria-label={table.label}
				aria-rowcount={table.rows.length + 1}
				className="flex min-w-0 flex-col overflow-hidden rounded-xl text-sm ring-1 ring-border/60"
			>
				<div
					role="row"
					aria-rowindex={1}
					className="grid gap-x-4 border-b border-border/50 px-3.5 py-2 text-xs font-medium text-muted-foreground"
					style={{ gridTemplateColumns }}
				>
					{table.columns.map((column, index) => (
						<span
							key={column.key}
							role="columnheader"
							className={cn("truncate", alignClass(index))}
						>
							{column.label}
						</span>
					))}
				</div>
				<div
					ref={setScrollElement}
					role="rowgroup"
					className="overflow-y-auto"
					style={{ maxHeight: ROW_HEIGHT * VISIBLE_ROWS }}
				>
					<div
						className="relative w-full"
						style={{ height: virtualizer.getTotalSize() }}
					>
						{virtualizer.getVirtualItems().map(virtualRow => {
							const row = table.rows[virtualRow.index]

							if (row === undefined) {
								return null
							}

							return (
								<div
									key={virtualRow.key}
									role="row"
									aria-rowindex={virtualRow.index + 2}
									className="absolute top-0 left-0 grid w-full items-center gap-x-4 px-3.5 select-text"
									style={{
										height: ROW_HEIGHT,
										gridTemplateColumns,
										transform: `translateY(${String(virtualRow.start)}px)`
									}}
								>
									{table.columns.map((column, index) => (
										<span
											key={column.key}
											role="cell"
											title={row[index]}
											className={cn("truncate", alignClass(index))}
										>
											{row[index]}
										</span>
									))}
								</div>
							)
						})}
					</div>
				</div>
			</div>
		</section>
	)
}

// The facts read from a file: titled sections of label/value fields, an optional table (a torrent's files, an
// archive's members) and a footer line. The data comes from workers as is; `renderValue` is the page's override for
// a value that needs more than text (a link through the trust gate), returning undefined to keep the default.
export function MetadataCard({
	title,
	subtitle,
	sections,
	table,
	footer,
	renderValue
}: {
	title: string
	subtitle?: string | undefined
	sections: readonly MetadataSectionData[]
	table?: MetadataTableData | undefined
	footer?: ReactNode
	renderValue?: MetadataValueRenderer | undefined
}) {
	return (
		<Card className="w-full min-w-0">
			<CardHeader>
				<CardTitle className="break-words">{title}</CardTitle>
				{subtitle === undefined ? null : <CardDescription>{subtitle}</CardDescription>}
			</CardHeader>
			<CardContent className="flex min-w-0 flex-col gap-4">
				{sections.map((section, index) => (
					<MetadataSection
						// Sections are positional; titles are optional and may repeat.
						key={index}
						section={section}
						renderValue={renderValue}
					/>
				))}
				{table === undefined ? null : <MetadataTable table={table} />}
			</CardContent>
			{footer === undefined ? null : <CardFooter className="text-xs text-muted-foreground">{footer}</CardFooter>}
		</Card>
	)
}
