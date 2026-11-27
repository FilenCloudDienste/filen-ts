import { useEffect, useEffectEvent, useState } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronRightIcon, CopyIcon } from "lucide-react"
import { cn, formatBytes } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { LazyTooltip } from "@/components/lazyTooltip"
import { copyText, copyTextLater } from "@/lib/copyText"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import type { DicomTagLevel, DicomTagRow } from "@/features/preview/lib/dicom/protocol"

const ROW_HEIGHT = 44
const OVERSCAN = 12

interface Shown {
	readonly key: string
	readonly path: readonly number[]
	readonly row: DicomTagRow | null
	// Rows of this level past what the worker sent (a row of its own, at the level's end).
	readonly more: number
}

// The visible rows: each loaded level under its expanded parent, depth-first.
function visibleRows(levels: ReadonlyMap<string, DicomTagLevel>, expanded: ReadonlySet<string>, path: readonly number[]): Shown[] {
	const level = levels.get(path.join("."))

	if (level === undefined) return []

	const rows: Shown[] = []

	level.rows.forEach((row, index) => {
		const child = [...path, index]
		const key = child.join(".")

		rows.push({ key, path: child, row, more: 0 })

		if (expanded.has(key)) rows.push(...visibleRows(levels, expanded, child))
	})

	if (level.more > 0) rows.push({ key: `${path.join(".")}+`, path, row: null, more: level.more })

	return rows
}

function TagValue({ row }: { row: DicomTagRow }) {
	const { t } = useTranslation("preview")

	if (row.children > 0) {
		return (
			<span className="text-muted-foreground">
				{t(row.item === null ? "previewDicomTagChildren" : "previewDicomTagElements", { count: row.children })}
			</span>
		)
	}
	if (row.value !== null) return <span className="font-mono select-text">{row.value}</span>
	if (row.length < 0) return <span className="text-muted-foreground">{t("previewDicomTagNotRead")}</span>

	return <span className="text-muted-foreground">{t("previewDicomTagBinary", { size: formatBytes(row.length) })}</span>
}

// The file's tags, as the worker names and reads them, one level at a time: sequences and items collapsed until opened,
// a window of rows drawn however many there are. One value at a time is copied, whole even when its row shows it cut.
// Its own file, as useVirtualizer opts it out of the React Compiler.
export function DicomTagTree({
	load,
	loadValue
}: {
	load: (path: readonly number[]) => Promise<DicomTagLevel>
	// The whole value of the row at a path, for a copy of one cut for its row.
	loadValue: (path: readonly number[]) => Promise<string | null>
}) {
	const { t } = useTranslation(["preview", "drive"])
	const [levels, setLevels] = useState<ReadonlyMap<string, DicomTagLevel>>(new Map())
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const read = (path: readonly number[]): void => {
		const key = path.join(".")

		if (levels.has(key)) return

		load(path).then(
			level => {
				setLevels(previous => new Map(previous).set(key, level))
			},
			() => undefined
		)
	}
	const readRoot = useEffectEvent(() => {
		read([])
	})

	useEffect(() => {
		readRoot()
	}, [])

	const rows = visibleRows(levels, expanded, [])
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => ROW_HEIGHT,
		overscan: OVERSCAN,
		getItemKey: index => rows[index]?.key ?? index
	})

	const toggle = (shown: Shown): void => {
		const open = !expanded.has(shown.key)

		setExpanded(previous => {
			const next = new Set(previous)

			if (open) next.add(shown.key)
			else next.delete(shown.key)

			return next
		})

		if (open) read(shown.path)
	}

	return (
		<div
			ref={setScrollElement}
			role="tree"
			aria-label={t("previewDicomTagsLabel")}
			className="size-full scrollbar-gutter-stable overflow-y-auto"
		>
			<ul
				role="none"
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(item => {
					const shown = rows[item.index]

					if (shown === undefined) return null

					const { row } = shown
					const depth = shown.path.length - (row === null ? 0 : 1)

					return (
						<li
							key={item.key}
							role="treeitem"
							aria-level={depth + 1}
							aria-expanded={row !== null && row.children > 0 ? expanded.has(shown.key) : undefined}
							className="absolute top-0 left-0 flex w-full items-center gap-1 border-b border-border/40 pr-1 text-xs"
							style={{
								height: ROW_HEIGHT,
								transform: `translateY(${String(item.start)}px)`,
								paddingInlineStart: 8 + depth * 12
							}}
						>
							{row === null ? (
								<span className="text-muted-foreground">{t("previewDicomTagsMore", { count: shown.more })}</span>
							) : (
								<>
									<button
										type="button"
										disabled={row.children === 0}
										aria-label={
											row.children > 0
												? t(expanded.has(shown.key) ? "drive:driveTreeCollapseNode" : "drive:driveTreeExpandNode", {
														name:
															row.item !== null
																? t("previewDicomTagItem", { number: row.item })
																: (row.name ?? row.tag)
													})
												: undefined
										}
										className="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-muted disabled:invisible"
										onClick={() => {
											toggle(shown)
										}}
									>
										<ChevronRightIcon
											className={cn("size-3.5 transition-transform", expanded.has(shown.key) && "rotate-90")}
										/>
									</button>
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="flex min-w-0 gap-1.5">
											<span className="shrink-0 font-mono text-muted-foreground">
												{row.item === null ? row.tag : ""}
											</span>
											<span className="truncate font-medium">
												{row.item !== null
													? t("previewDicomTagItem", { number: row.item })
													: (row.name ??
														(row.isPrivate ? t("previewDicomTagPrivate") : t("previewDicomTagUnknown")))}
											</span>
											{row.vr !== "" ? <span className="shrink-0 text-muted-foreground">{row.vr}</span> : null}
										</span>
										<span className="truncate">
											<TagValue row={row} />
										</span>
									</span>
									{row.value !== null && row.value !== "" ? (
										<LazyTooltip
											label={t("previewDicomTagCopy")}
											className="flex shrink-0"
										>
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label={t("previewDicomTagCopy")}
												onClick={() => {
													const copied = t("previewDicomTagCopied")

													if (row.truncated) {
														void copyTextLater(loadValue(shown.path), {
															copied,
															failed: t("previewDicomTagCopyFailed")
														})
													} else {
														void copyText(row.value ?? "", copied)
													}
												}}
											>
												<CopyIcon />
											</Button>
										</LazyTooltip>
									) : null}
								</>
							)}
						</li>
					)
				})}
			</ul>
		</div>
	)
}
