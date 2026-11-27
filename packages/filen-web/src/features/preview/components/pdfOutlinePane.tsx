import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronDownIcon, ChevronRightIcon, XIcon } from "lucide-react"
import { resolveDestination, type PdfDestination, type PdfOutlineItem } from "@filen/office/dom/pdf"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { scheduleIdle } from "@filen/shared/dom/scheduleIdle"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import { cn } from "@filen/shared"
import {
	currentSection,
	hasChildren,
	outlineKeyMove,
	outlinePositions,
	rowsToResolve,
	visibleRows,
	type OutlineKey
} from "@/features/preview/lib/pdfOutline.logic"

// The document's outline as a tree beside the pages (the viewer's left pane, the editor's rail tab): the bookmarks as
// rows, collapsible, the arrow keys moving through them and Enter going to one; the section the current page is in is
// marked. A row's destination is resolved (which on a ranged file can read the page tree) only once it is on screen
// or near it, in idle time, and kept with the document. Its own file, as useVirtualizer opts it out of the React
// Compiler.

const ROW_HEIGHT = 28
const OVERSCAN = 8
const KEYS = new Set<string>(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"])

// Each document's resolved rows, per outline read from it: item index to its 1-based page, null for one leading
// nowhere. Keyed by both, as a host can pair a new document (a relaid e-book) with the old one's outline for a moment.
const resolvedByDocument = new WeakMap<PdfDomDocument, WeakMap<readonly PdfOutlineItem[], Map<number, number | null>>>()

function resolvedOf(document: PdfDomDocument, outline: readonly PdfOutlineItem[]): Map<number, number | null> {
	let byOutline = resolvedByDocument.get(document)

	if (byOutline === undefined) {
		byOutline = new WeakMap()
		resolvedByDocument.set(document, byOutline)
	}

	let resolved = byOutline.get(outline)

	if (resolved === undefined) {
		resolved = new Map()
		byOutline.set(outline, resolved)
	}

	return resolved
}

export interface PdfOutlinePaneProps {
	readonly document: PdfDomDocument
	readonly outline: readonly PdfOutlineItem[]
	// The page shown, 1-based.
	readonly page: number
	readonly onGo: (to: PdfDestination) => void
	// The pane's own close button (the viewer's pane; the editor's tab has none).
	readonly onClose?: () => void
	readonly className?: string
}

export function PdfOutlinePane({ document, outline, page, onGo, onClose, className }: PdfOutlinePaneProps) {
	const { t } = useTranslation("preview")
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set())
	const [focused, setFocused] = useState(0)
	// Bumped as destinations resolve (the cache is outside React state).
	const [, setResolvedCount] = useState(0)
	const focusAfterRender = useRef(false)
	const resolved = resolvedOf(document, outline)
	// Memoized by hand: useVirtualizer opts this component out of the compiler, and it re-renders on every range,
	// page and resolved destination.
	const rows = useMemo(() => visibleRows(outline, collapsed), [outline, collapsed])
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => ROW_HEIGHT,
		overscan: OVERSCAN
	})
	const range = virtualizer.range
	const first = range?.startIndex ?? 0
	const last = range?.endIndex ?? -1
	const current = currentSection(resolved, page)
	const positions = useMemo(() => outlinePositions(outline), [outline])
	const virtualRows = virtualizer.getVirtualItems()
	// The roving tab stop is the focused row while it is rendered; scrolled away, the tree itself takes Tab and hands
	// focus to the first row on screen.
	const focusedRendered = virtualRows.some(row => rows[row.index] === focused)

	// The rows on screen and the margin, resolved in idle time a few at a time; never the rest.
	useEffect(() => {
		const wanted = rowsToResolve(rows, first, last, resolved)

		if (wanted.length === 0) return

		let live = true
		let cancel = scheduleIdle(function step() {
			const index = wanted.shift()

			if (!live || index === undefined) return

			const dest = outline[index]?.dest ?? null
			const done = dest === null ? Promise.resolve(null) : resolveDestination(document, dest)

			void done.then(to => {
				resolved.set(index, to?.page ?? null)

				if (!live) return

				setResolvedCount(count => count + 1)
				cancel = scheduleIdle(step)
			})
		})

		return () => {
			live = false
			cancel()
		}
	}, [document, outline, rows, first, last, resolved])

	// Focus follows a key that moved it, once the row is rendered.
	useEffect(() => {
		if (!focusAfterRender.current || scrollElement === null) return

		focusAfterRender.current = false
		scrollElement.querySelector<HTMLElement>(`[data-item="${String(focused)}"]`)?.focus()
	})

	const go = (index: number): void => {
		const dest = outline[index]?.dest ?? null

		if (dest === null) return

		void resolveDestination(document, dest).then(to => {
			if (to !== null) onGo(to)
		})
	}

	const toggle = (index: number): void => {
		setCollapsed(previous => {
			const next = new Set(previous)

			if (!next.delete(index)) next.add(index)

			return next
		})
	}

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault()
			go(focused)

			return
		}

		if (!KEYS.has(event.key)) return

		const move = outlineKeyMove(outline, rows, collapsed, focused, event.key as OutlineKey)

		event.preventDefault()

		if (move === null) return

		if (move.kind === "focus") {
			setFocused(move.index)
			focusAfterRender.current = true
			virtualizer.scrollToIndex(Math.max(0, rows.indexOf(move.index)))
		} else toggle(move.index)
	}

	return (
		<div className={cn("flex min-h-0 flex-col", className)}>
			{onClose === undefined ? null : (
				<div className="flex h-9 shrink-0 items-center justify-between border-b border-border pr-1 pl-3">
					<span className="text-sm font-medium">{t("previewPdfOutlinePane")}</span>
					<TooltipIconButton
						label={t("previewPdfOutlinePaneClose")}
						onClick={onClose}
					>
						<XIcon />
					</TooltipIconButton>
				</div>
			)}
			<div
				ref={setScrollElement}
				role="tree"
				aria-label={t("previewPdfOutlinePane")}
				tabIndex={focusedRendered ? -1 : 0}
				className="min-h-0 flex-1 scrollbar-gutter-stable overflow-y-auto py-1 outline-none"
				onKeyDown={onKeyDown}
				onFocus={event => {
					if (event.target !== event.currentTarget) return

					const first = virtualRows.map(row => rows[row.index]).find(index => index !== undefined)

					if (first !== undefined) {
						setFocused(first)
						event.currentTarget.querySelector<HTMLElement>(`[data-item="${String(first)}"]`)?.focus()
					}
				}}
			>
				<div
					className="relative w-full"
					style={{ height: virtualizer.getTotalSize() }}
				>
					{virtualRows.map(row => {
						const index = rows[row.index]
						const item = index === undefined ? undefined : outline[index]

						if (index === undefined || item === undefined) return null

						const parent = hasChildren(outline, index)
						const open = parent && !collapsed.has(index)

						return (
							<div
								key={index}
								role="treeitem"
								data-item={index}
								aria-level={item.depth + 1}
								aria-posinset={positions[index]?.posInSet}
								aria-setsize={positions[index]?.setSize}
								aria-expanded={parent ? open : undefined}
								aria-current={current === index ? "location" : undefined}
								aria-disabled={item.dest === null ? true : undefined}
								tabIndex={focused === index ? 0 : -1}
								className={cn(
									"absolute top-0 left-0 flex w-full cursor-default items-center gap-1 rounded-sm pr-2 text-sm focus-ring-row",
									current === index ? "bg-accent font-medium text-accent-foreground" : "hover:bg-accent/50",
									item.dest === null ? "text-muted-foreground" : undefined
								)}
								style={{
									height: ROW_HEIGHT,
									transform: `translateY(${String(row.start)}px)`,
									paddingInlineStart: `${String(0.25 + item.depth * 0.75)}rem`
								}}
								onFocus={() => {
									setFocused(index)
								}}
								onClick={() => {
									setFocused(index)
									go(index)
								}}
							>
								{parent ? (
									<span
										aria-hidden="true"
										className="flex size-4 shrink-0 items-center justify-center"
										onClick={event => {
											event.stopPropagation()
											toggle(index)
										}}
									>
										{open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
									</span>
								) : (
									<span className="size-4 shrink-0" />
								)}
								<span className="min-w-0 truncate">{item.title}</span>
							</div>
						)
					})}
				</div>
			</div>
		</div>
	)
}
