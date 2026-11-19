import { useEffect, useId, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon, MessageSquareTextIcon } from "lucide-react"
import { cn } from "@filen/shared"
import {
	RECT_FLOATS,
	revisionColor,
	type DocxAnnotations,
	type DocxComment,
	type DocxMarkupInfo,
	type DocxPageData
} from "@filen/office/dom/docx"
import {
	changeBarX,
	placeBalloons,
	type DocxAnnotationAnchor,
	type DocxAnnotationIndex,
	type DocxPageFrame
} from "@filen/office/react/docx"
import { formattingKeys, splitBalloons } from "@/features/preview/components/docxViewer.logic"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { formatShortDate } from "@/lib/formatDate"

// Comments and tracked changes beside and on the pages, the way Word's review pane shows them: change bars
// left of changed lines, commented text shaded in its author's colour, and balloons in a column right of
// each page, joined to the text they belong to. Read-only: replying and resolving come with editing.
// Drawn inside the page list's scrolled content (DocxPages' overlay), from the mounted pages' frames.

// Space between the page and the balloon column, and between balloons (screen px).
const COLUMN_GAP = 16
const BALLOON_GAP = 8
// Before a balloon is measured.
const ESTIMATED_HEIGHT = 64
// Where a balloon's connector meets it, below its top.
const CONNECTOR_Y = 14
// The "+N more" control's height.
const MORE_HEIGHT = 28
// Comment markers closer than this on screen share one marker.
const MARKER_SPACING = 26

// "c<comment>" for a comment thread, "f<revision>" for a formatting change.
export type DocxBalloonKey = string

interface Balloon {
	readonly key: DocxBalloonKey
	readonly anchor: DocxAnnotationAnchor
	readonly author: number
}

export interface DocxAnnotationLayerProps {
	annotations: DocxAnnotations
	index: DocxAnnotationIndex
	markup: DocxMarkupInfo
	frames: readonly DocxPageFrame[]
	pages: readonly (DocxPageData | undefined)[]
	zoom: number
	// Width of the balloon column; 0: no room, markers at the page edge instead.
	asideWidth: number
	active: DocxBalloonKey | null
	onActivate: (key: DocxBalloonKey | null) => void
}

function authorName(annotations: DocxAnnotations, author: number, unknown: string): string {
	return annotations.authors[author] ?? unknown
}

function dateLabel(date: string): string {
	return date.length > 0 ? formatShortDate(date) : ""
}

// The balloons of one page, in anchor order.
function pageBalloons(annotations: DocxAnnotations, index: DocxAnnotationIndex, markup: DocxMarkupInfo, page: number): Balloon[] {
	const entry = index.pages.get(page)
	const out: Balloon[] = []

	if (markup.comments) {
		// Comments nothing in the laid-out text anchors sit at the top of the first page.
		if (page === 0) {
			for (const comment of index.unanchored) {
				out.push({
					key: `c${String(comment)}`,
					anchor: { index: comment, x: -1, y: 0, height: 0 },
					author: annotations.comments[comment]?.author ?? -1
				})
			}
		}

		for (const anchor of entry?.threads ?? []) {
			out.push({ key: `c${String(anchor.index)}`, anchor, author: annotations.comments[anchor.index]?.author ?? -1 })
		}
	}

	if (markup.formatting) {
		for (const anchor of entry?.formatting ?? []) {
			out.push({ key: `f${String(anchor.index)}`, anchor, author: annotations.revisions[anchor.index]?.author ?? -1 })
		}
	}

	return out.sort((a, b) => a.anchor.y - b.anchor.y || a.anchor.x - b.anchor.x)
}

interface PlacedColumn {
	readonly frame: DocxPageFrame
	readonly balloons: readonly Balloon[]
	// The balloons beside the page, at `tops`.
	readonly shown: readonly Balloon[]
	readonly tops: Float64Array
	// Those that did not fit beside the page: behind a "+N more" control at moreTop.
	readonly hidden: readonly Balloon[]
	readonly moreTop: number
}

// Each page's balloons within that page's own column, as Word lays them out: what does not fit beside the
// page waits behind a "+N more" control. A page's placement depends on that page alone, so balloons stay
// put while other pages mount and unmount.
function placeColumns(
	annotations: DocxAnnotations,
	index: DocxAnnotationIndex,
	markup: DocxMarkupInfo,
	frames: readonly DocxPageFrame[],
	zoom: number,
	heights: ReadonlyMap<DocxBalloonKey, number>,
	active: DocxBalloonKey | null
): PlacedColumn[] {
	return frames.map(frame => {
		const balloons = pageBalloons(annotations, index, markup, frame.index)
		const wanted = balloons.map(balloon => frame.top + (balloon.anchor.y + balloon.anchor.height * 0.5) * zoom - CONNECTOR_Y)
		const sizes = balloons.map(balloon => heights.get(balloon.key) ?? ESTIMATED_HEIGHT)
		const activeAt = balloons.findIndex(balloon => balloon.key === active)
		const placed = placeBalloons(wanted, sizes, {
			gap: BALLOON_GAP,
			top: frame.top,
			bottom: frame.top + frame.height,
			more: MORE_HEIGHT,
			...(activeAt >= 0 ? { active: activeAt } : {})
		})

		return { frame, balloons, ...splitBalloons(balloons, placed), tops: placed.tops, moreTop: placed.moreTop }
	})
}

function CommentText({ comment, clamp }: { comment: DocxComment; clamp: boolean }) {
	return (
		<div className={cn("flex flex-col gap-1 break-words whitespace-pre-wrap", clamp && "line-clamp-4")}>
			{comment.paragraphs.map((runs, paragraph) => (
				<p key={paragraph}>
					{runs.map((run, at) => (
						<span
							key={at}
							className={cn(
								run.bold && "font-semibold",
								run.italic && "italic",
								run.strike ? "line-through" : run.underline && "underline"
							)}
						>
							{run.text}
						</span>
					))}
				</p>
			))}
		</div>
	)
}

export function Byline({ name, date, color }: { name: string; date: string; color: string }) {
	return (
		<div className="flex min-w-0 items-center gap-1.5">
			<span
				aria-hidden="true"
				className="size-2 shrink-0 rounded-full"
				style={{ backgroundColor: color }}
			/>
			<span className="truncate font-medium text-foreground">{name}</span>
			{date.length > 0 ? <span className="shrink-0 text-muted-foreground">{date}</span> : null}
		</div>
	)
}

// A comment and its replies.
function Thread({
	annotations,
	index,
	comment,
	expanded
}: {
	annotations: DocxAnnotations
	index: DocxAnnotationIndex
	comment: number
	expanded: boolean
}) {
	const { t } = useTranslation("preview")
	const root = annotations.comments[comment]

	if (root === undefined) {
		return null
	}

	const unknown = t("previewDocxUnknownAuthor")

	return (
		<div className={cn("flex flex-col gap-2", root.done && !expanded && "opacity-70")}>
			<div className="flex flex-col gap-1">
				<div className="flex items-center justify-between gap-2">
					<Byline
						name={authorName(annotations, root.author, unknown)}
						date={dateLabel(root.date)}
						color={revisionColor(root.author)}
					/>
					{root.done ? <span className="shrink-0 text-muted-foreground">{t("previewDocxCommentResolved")}</span> : null}
				</div>
				<CommentText
					comment={root}
					clamp={!expanded}
				/>
			</div>
			{(index.threads[comment]?.replies ?? []).map(reply => {
				const entry = annotations.comments[reply]

				return entry === undefined ? null : (
					<div
						key={reply}
						className="flex flex-col gap-1 border-t border-border pt-2"
					>
						<Byline
							name={authorName(annotations, entry.author, unknown)}
							date={dateLabel(entry.date)}
							color={revisionColor(entry.author)}
						/>
						<CommentText
							comment={entry}
							clamp={!expanded}
						/>
					</div>
				)
			})}
		</div>
	)
}

function Formatting({ annotations, revision }: { annotations: DocxAnnotations; revision: number }) {
	const { t } = useTranslation("preview")
	const entry = annotations.revisions[revision]

	if (entry === undefined) {
		return null
	}

	const keys = formattingKeys(entry.target, entry.properties)

	return (
		<div className="flex flex-col gap-1">
			<Byline
				name={authorName(annotations, entry.author, t("previewDocxUnknownAuthor"))}
				date={dateLabel(entry.date)}
				color={revisionColor(entry.author)}
			/>
			<p>
				{keys.length === 0
					? t("previewDocxFormatted")
					: t("previewDocxFormattedProperties", { properties: keys.map(key => t(key)).join(", ") })}
			</p>
		</div>
	)
}

function BalloonBody({
	annotations,
	index,
	balloon,
	expanded
}: {
	annotations: DocxAnnotations
	index: DocxAnnotationIndex
	balloon: DocxBalloonKey
	expanded: boolean
}) {
	const at = Number(balloon.slice(1))

	return balloon.startsWith("c") ? (
		<Thread
			annotations={annotations}
			index={index}
			comment={at}
			expanded={expanded}
		/>
	) : (
		<Formatting
			annotations={annotations}
			revision={at}
		/>
	)
}

// Commented text shaded in its author's colour, stronger for the thread in focus.
function Ranges({
	annotations,
	ranges,
	frame,
	zoom,
	active,
	all
}: {
	annotations: DocxAnnotations
	ranges: Int32Array
	frame: DocxPageFrame
	zoom: number
	active: number
	all: boolean
}) {
	const boxes: ReactNode[] = []

	for (let k = 0; k + 1 < ranges.length; k += 2) {
		const comment = ranges[k] ?? -1
		const rect = ranges[k + 1] ?? -1
		const current = comment === active

		if (!all && !current) {
			continue
		}

		const f = rect * RECT_FLOATS
		const color = revisionColor(annotations.comments[comment]?.author ?? -1)

		boxes.push(
			<div
				key={rect}
				aria-hidden="true"
				className="pointer-events-none absolute mix-blend-multiply"
				style={{
					left: frame.left + (annotations.rectFloats[f] ?? 0) * zoom,
					top: frame.top + (annotations.rectFloats[f + 1] ?? 0) * zoom,
					width: Math.max(2, (annotations.rectFloats[f + 2] ?? 0) * zoom),
					height: (annotations.rectFloats[f + 3] ?? 0) * zoom,
					backgroundColor: `color-mix(in oklab, ${color} ${current ? "38%" : "16%"}, transparent)`
				}}
			/>
		)
	}

	return boxes
}

function Bars({
	bars,
	frame,
	page,
	zoom,
	color
}: {
	bars: Float32Array
	frame: DocxPageFrame
	page: DocxPageData
	zoom: number
	color: string
}) {
	const x = frame.left + changeBarX(page) * zoom
	const out: ReactNode[] = []

	for (let k = 0; k + 1 < bars.length; k += 2) {
		out.push(
			<div
				key={k}
				aria-hidden="true"
				className="pointer-events-none absolute"
				style={{
					backgroundColor: color,
					left: x,
					top: frame.top + (bars[k] ?? 0) * zoom,
					width: Math.max(1.5, 2 * zoom),
					height: (bars[k + 1] ?? 0) * zoom
				}}
			/>
		)
	}

	return out
}

// The balloon column of one page, with the lines joining each balloon to its text.
function Column({
	annotations,
	index,
	column,
	zoom,
	width,
	connectors,
	active,
	onActivate,
	register
}: {
	annotations: DocxAnnotations
	index: DocxAnnotationIndex
	column: PlacedColumn
	zoom: number
	width: number
	connectors: boolean
	active: DocxBalloonKey | null
	onActivate: (key: DocxBalloonKey | null) => void
	register: (element: HTMLElement | null) => (() => void) | undefined
}) {
	const { t } = useTranslation("preview")
	const ids = useId()
	const { frame, tops, shown: balloons, hidden } = column
	const left = frame.left + frame.width + COLUMN_GAP

	return (
		<>
			<svg
				aria-hidden="true"
				className="pointer-events-none absolute overflow-visible"
				style={{ left: frame.left, top: frame.top, width: frame.width + COLUMN_GAP, height: frame.height }}
			>
				{balloons.map((balloon, k) => {
					// All markup joins every balloon to its text, as Word does; the others only the one in focus.
					if (balloon.anchor.x < 0 || (!connectors && balloon.key !== active)) {
						return null
					}

					const ax = balloon.anchor.x * zoom
					const ay = (balloon.anchor.y + balloon.anchor.height) * zoom
					const by = (tops[k] ?? 0) - frame.top + CONNECTOR_Y
					const current = balloon.key === active

					return (
						<path
							key={balloon.key}
							d={`M ${String(ax)} ${String(ay)} H ${String(frame.width)} L ${String(frame.width + COLUMN_GAP)} ${String(by)}`}
							fill="none"
							stroke={revisionColor(balloon.author)}
							strokeWidth={current ? 1.5 : 1}
							strokeDasharray={current ? undefined : "3 3"}
							opacity={current ? 1 : 0.7}
						/>
					)
				})}
			</svg>
			{balloons.map((balloon, k) => {
				const current = balloon.key === active
				const body = `${ids}-${balloon.key}`
				const toggle = (): void => {
					onActivate(current ? null : balloon.key)
				}

				return (
					<article
						key={balloon.key}
						ref={register}
						data-balloon={balloon.key}
						aria-label={
							balloon.key.startsWith("c")
								? t("previewDocxCommentLabel", {
										author: authorName(annotations, balloon.author, t("previewDocxUnknownAuthor"))
									})
								: t("previewDocxFormatted")
						}
						className={cn(
							"group/balloon absolute cursor-pointer rounded-xl border border-l-[3px] border-border bg-popover p-2.5 pr-7 text-xs text-popover-foreground shadow-sm",
							current && "z-10 shadow-md"
						)}
						style={{ left, top: tops[k], width, borderLeftColor: revisionColor(balloon.author) }}
						onClick={toggle}
					>
						<button
							type="button"
							aria-expanded={current}
							aria-controls={body}
							aria-label={current ? t("previewDocxBalloonCollapse") : t("previewDocxBalloonExpand")}
							className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
							onClick={event => {
								// The balloon's own click toggles too.
								event.stopPropagation()
								toggle()
							}}
						>
							<ChevronDownIcon className={cn("size-3.5", current && "rotate-180")} />
						</button>
						<div id={body}>
							<BalloonBody
								annotations={annotations}
								index={index}
								balloon={balloon.key}
								expanded={current}
							/>
						</div>
					</article>
				)
			})}
			{hidden.length === 0 ? null : (
				<Popover>
					<PopoverTrigger
						className="absolute flex items-center justify-center rounded-xl border border-border bg-popover text-xs font-medium text-popover-foreground shadow-sm outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
						style={{ left, top: column.moreTop, width, height: MORE_HEIGHT }}
					>
						{t("previewDocxMoreBalloons", { count: hidden.length })}
					</PopoverTrigger>
					<PopoverContent
						align="start"
						className="max-h-96 w-72 gap-3 overflow-y-auto rounded-2xl p-3 text-xs"
					>
						{hidden.map(balloon => (
							<div
								key={balloon.key}
								className="border-l-[3px] pl-2"
								style={{ borderLeftColor: revisionColor(balloon.author) }}
							>
								<BalloonBody
									annotations={annotations}
									index={index}
									balloon={balloon.key}
									expanded
								/>
							</div>
						))}
					</PopoverContent>
				</Popover>
			)}
		</>
	)
}

// Without room for balloons: a marker at the page's right edge per group of nearby comments, its threads
// in a popover.
function Markers({
	annotations,
	index,
	balloons,
	frame,
	zoom
}: {
	annotations: DocxAnnotations
	index: DocxAnnotationIndex
	balloons: readonly Balloon[]
	frame: DocxPageFrame
	zoom: number
}) {
	const { t } = useTranslation("preview")
	const lines: Balloon[][] = []

	for (const balloon of balloons) {
		const line = lines[lines.length - 1]
		const first = line?.[0]

		if (line !== undefined && first !== undefined && Math.abs(first.anchor.y - balloon.anchor.y) * zoom < MARKER_SPACING) {
			line.push(balloon)
		} else {
			lines.push([balloon])
		}
	}

	return lines.map(line => {
		const first = line[0]

		if (first === undefined) {
			return null
		}

		return (
			<Popover key={first.key}>
				<PopoverTrigger
					aria-label={
						first.key.startsWith("c")
							? t("previewDocxCommentMarker", {
									author: authorName(annotations, first.author, t("previewDocxUnknownAuthor"))
								})
							: t("previewDocxFormatted")
					}
					className="absolute flex size-6 items-center justify-center rounded-full bg-popover shadow-sm ring-1 ring-border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
					style={{
						left: frame.left + frame.width - 30,
						top: frame.top + Math.max(0, first.anchor.y * zoom - 2),
						color: revisionColor(first.author)
					}}
				>
					<MessageSquareTextIcon className="size-3.5" />
				</PopoverTrigger>
				<PopoverContent
					align="end"
					className="max-h-80 w-72 gap-3 overflow-y-auto rounded-2xl p-3 text-xs"
				>
					{line.map(balloon => (
						<BalloonBody
							key={balloon.key}
							annotations={annotations}
							index={index}
							balloon={balloon.key}
							expanded
						/>
					))}
				</PopoverContent>
			</Popover>
		)
	})
}

export function DocxAnnotationLayer({
	annotations,
	index,
	markup,
	frames,
	pages,
	zoom,
	asideWidth,
	active,
	onActivate
}: DocxAnnotationLayerProps) {
	const { t } = useTranslation("preview")
	const [heights, setHeights] = useState<ReadonlyMap<DocxBalloonKey, number>>(() => new Map())
	// Balloons are placed by their measured heights, observed as they render and change.
	const [observer] = useState(() =>
		typeof ResizeObserver === "function"
			? new ResizeObserver(entries => {
					setHeights(previous => {
						const next = new Map(previous)
						let changed = false

						for (const entry of entries) {
							const key = entry.target instanceof HTMLElement ? entry.target.dataset["balloon"] : undefined
							const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height

							if (key !== undefined && Math.abs((previous.get(key) ?? -1) - height) >= 1) {
								next.set(key, height)
								changed = true
							}
						}

						return changed ? next : previous
					})
				})
			: null
	)
	const balloonWidth = asideWidth - 2 * COLUMN_GAP
	const activeComment = active?.startsWith("c") === true ? Number(active.slice(1)) : -1

	useEffect(() => {
		return () => {
			observer?.disconnect()
		}
	}, [observer])

	const register = (element: HTMLElement | null): (() => void) | undefined => {
		if (element === null || observer === null) {
			return undefined
		}

		observer.observe(element)

		return () => {
			observer.unobserve(element)
		}
	}

	const columns = placeColumns(annotations, index, markup, frames, zoom, heights, active)

	return (
		<div
			role={asideWidth > 0 ? "complementary" : undefined}
			aria-label={asideWidth > 0 ? t("previewDocxComments") : undefined}
		>
			{columns.map(column => {
				const { frame, balloons } = column
				const page = pages[frame.index]
				const entry = index.pages.get(frame.index)

				return (
					<div key={frame.index}>
						{markup.changeBars && page !== undefined && entry !== undefined ? (
							<Bars
								bars={entry.bars}
								frame={frame}
								page={page}
								zoom={zoom}
								// Word marks changed lines red in Simple Markup and with its plain bars in All Markup.
								color={
									markup.highlights ? "var(--fo-revision-bar)" : "var(--fo-revision-bar-simple, var(--fo-revision-bar))"
								}
							/>
						) : null}
						{entry !== undefined && (markup.highlights || activeComment >= 0) ? (
							<Ranges
								annotations={annotations}
								ranges={entry.ranges}
								frame={frame}
								zoom={zoom}
								active={activeComment}
								all={markup.highlights}
							/>
						) : null}
						{balloons.length === 0 ? null : asideWidth > 0 ? (
							<Column
								annotations={annotations}
								index={index}
								column={column}
								zoom={zoom}
								width={balloonWidth}
								connectors={markup.highlights}
								active={active}
								onActivate={onActivate}
								register={register}
							/>
						) : (
							<Markers
								annotations={annotations}
								index={index}
								balloons={balloons}
								frame={frame}
								zoom={zoom}
							/>
						)}
					</div>
				)
			})}
		</div>
	)
}
