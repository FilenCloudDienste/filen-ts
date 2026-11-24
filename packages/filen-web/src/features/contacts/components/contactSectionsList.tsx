import { useCallback, useLayoutEffect, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual"
import { cn } from "@filen/shared"
import type { ContactSection } from "@/features/contacts/components/contactsList.logic"
import type { ContactSectionKey } from "@/features/contacts/lib/selection"
import { SURFACE_RING } from "@/components/ui/surface"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

export interface ContactSectionView {
	section: ContactSection
	// The section's row uuids in order: one array per render, shared by its key handler and its rows.
	uuids: string[]
	// The listbox's accessible name.
	label: string
	// Shown above the rows, or null for a bare panel (a single-section view, named by the page's <h1>).
	heading: string | null
	// Incoming requests in the "all" view: a tinted panel around the heading and rows.
	callout: boolean
}

export interface ContactSectionsListProps {
	sections: readonly ContactSectionView[]
	// Room below the last section (the floating bulk bar's, while it shows).
	bottomPadding: number
	activeIndexFor: (section: ContactSectionKey, uuids: readonly string[]) => number
	onKeyDown: (section: ContactSectionKey, uuids: readonly string[], event: KeyboardEvent<HTMLDivElement>) => void
	// The row at `index` of a section: a ContactRow with its actions, `active` holding the section's Tab stop.
	renderRow: (view: ContactSectionView, index: number, active: boolean) => ReactNode
	// Set to this list's scroll-into-view, for the selection's arrow keys.
	revealRef: RefObject<((section: ContactSectionKey, index: number) => void) | null>
}

// A ContactRow (h-14) and the hairline below every row but a section's last.
const ROW_HEIGHT = 56
const ROW_DIVIDER = 1
// The column's pt-1 and the gap-6 between sections.
const LIST_PADDING_TOP = 4
const SECTION_GAP = 24
// A labelled section's heading (text-xs in its pb-2), and the callout's (text-sm in pt-3 pb-2, over its hairline).
const HEADING_HEIGHT = 24
const CALLOUT_HEADING_HEIGHT = 41
const OVERSCAN = 8

// Every section's rows sit in a rounded, ringed panel (ui/card.tsx's ring language) with hairlines between rows.
const PANEL_CLASS = "overflow-hidden rounded-2xl ring-1"

type FlatItem = { kind: "head"; section: number } | { kind: "row"; section: number; index: number }

interface SectionLayout {
	headIndex: number
	// The flat index of the section's first row.
	firstRow: number
	headingHeight: number
	gapBefore: number
}

function headingHeightOf(view: ContactSectionView): number {
	return view.heading === null ? 0 : view.callout ? CALLOUT_HEADING_HEIGHT : HEADING_HEIGHT
}

function rowsHeight(count: number): number {
	return count === 0 ? 0 : count * (ROW_HEIGHT + ROW_DIVIDER) - ROW_DIVIDER
}

// The contacts page's sections as one window over a flat list of section heads and rows, each section still its own
// listbox: an account with hundreds of contacts mounts what is in view. Every row's height is fixed, so the layout is
// known without measuring. Each section's cursor row stays mounted, so Tab always reaches its listbox. Its own file,
// as useVirtualizer opts it out of the React Compiler (the page stays compiled).
export function ContactSectionsList({
	sections,
	bottomPadding,
	activeIndexFor,
	onKeyDown,
	renderRow,
	revealRef
}: ContactSectionsListProps) {
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const items: FlatItem[] = []
	const layouts: SectionLayout[] = []
	const activeIndexes: number[] = []

	for (const [sectionIndex, view] of sections.entries()) {
		layouts.push({
			headIndex: items.length,
			firstRow: items.length + 1,
			headingHeight: headingHeightOf(view),
			gapBefore: sectionIndex === 0 ? 0 : SECTION_GAP
		})
		items.push({ kind: "head", section: sectionIndex })

		for (let index = 0; index < view.uuids.length; index++) {
			items.push({ kind: "row", section: sectionIndex, index })
		}

		activeIndexes.push(activeIndexFor(view.section.key, view.uuids))
	}

	const pinned = layouts.flatMap((layout, sectionIndex) => {
		const active = activeIndexes[sectionIndex] ?? -1

		return active >= 0 ? [layout.firstRow + active] : []
	})
	const pinnedKey = pinned.join(",")

	// Memoized by hand: a new extractor re-runs the range, so it changes with the pinned rows and nothing else.
	const rangeExtractor = useCallback(
		(range: Range) => {
			const indexes = defaultRangeExtractor(range)
			const missing =
				pinnedKey === ""
					? []
					: pinnedKey
							.split(",")
							.map(Number)
							.filter(index => !indexes.includes(index))

			return missing.length === 0 ? indexes : [...missing, ...indexes].sort((a, b) => a - b)
		},
		[pinnedKey]
	)

	const virtualizer = useVirtualizer({
		count: items.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: index => {
			const item = items[index]

			if (item === undefined) {
				return 0
			}

			const layout = layouts[item.section]
			const view = sections[item.section]

			if (layout === undefined || view === undefined) {
				return 0
			}

			if (item.kind === "head") {
				return layout.gapBefore + layout.headingHeight
			}

			return item.index === view.uuids.length - 1 ? ROW_HEIGHT : ROW_HEIGHT + ROW_DIVIDER
		},
		paddingStart: LIST_PADDING_TOP,
		paddingEnd: bottomPadding,
		overscan: OVERSCAN,
		getItemKey: index => {
			const item = items[index]
			const view = item === undefined ? undefined : sections[item.section]

			if (item === undefined || view === undefined) {
				return index
			}

			return item.kind === "head" ? `head:${view.section.key}` : `${view.section.key}:${view.uuids[item.index] ?? String(item.index)}`
		},
		rangeExtractor
	})

	useLayoutEffect(() => {
		revealRef.current = (key, index) => {
			const sectionIndex = sections.findIndex(view => view.section.key === key)
			const layout = layouts[sectionIndex]

			if (layout !== undefined) {
				virtualizer.scrollToIndex(layout.firstRow + index)
			}
		}
	})

	const virtualItems = virtualizer.getVirtualItems()

	function renderSection(view: ContactSectionView, sectionIndex: number): ReactNode {
		const layout = layouts[sectionIndex]

		if (layout === undefined) {
			return null
		}

		const top = (virtualizer.measurementsCache[layout.headIndex]?.start ?? 0) + layout.gapBefore
		const rowsTop = top + layout.headingHeight
		const height = rowsHeight(view.uuids.length)
		const active = activeIndexes[sectionIndex] ?? -1
		const options: ReactNode[] = []

		for (const virtualRow of virtualItems) {
			const item = items[virtualRow.index]

			if (item?.kind !== "row" || item.section !== sectionIndex) {
				continue
			}

			const last = item.index === view.uuids.length - 1

			options.push(
				// Presentational: it only positions the row, and a generic container between listbox and option
				// breaks the owned-element relationship.
				<div
					key={virtualRow.key}
					role="presentation"
					className={cn(
						"absolute top-0 left-0 w-full",
						!last && "border-b",
						!last && (view.callout ? "border-primary/10" : "border-border")
					)}
					style={{
						height: last ? ROW_HEIGHT : ROW_HEIGHT + ROW_DIVIDER,
						transform: `translateY(${String(virtualRow.start - rowsTop)}px)`
					}}
				>
					{renderRow(view, item.index, item.index === active)}
				</div>
			)
		}

		const listbox = (
			<div
				role="listbox"
				aria-multiselectable="true"
				aria-label={view.label}
				// One roving Tab stop per section: the cursor row (and only its controls) is tabbable,
				// Arrow/Home/End move it, Space/Enter toggle it. Same contract as drive's listbox.
				onKeyDown={event => {
					onKeyDown(view.section.key, view.uuids, event)
				}}
				className={view.callout ? "relative" : cn("relative", PANEL_CLASS, SURFACE_RING)}
				style={{ height }}
			>
				{options}
			</div>
		)

		return (
			<section
				key={view.section.key}
				className={cn(
					"absolute top-0 left-0 w-full",
					view.callout && cn(PANEL_CLASS, "bg-primary/3 ring-primary/15 dark:bg-primary/5")
				)}
				style={{ height: layout.headingHeight + height, transform: `translateY(${String(top)}px)` }}
			>
				{view.heading === null ? null : view.callout ? (
					<h2 className="truncate border-b px-3 pt-3 pb-2 text-sm font-medium">{view.heading}</h2>
				) : (
					<h2 className="truncate px-1 pb-2 text-xs font-medium text-muted-foreground">{view.heading}</h2>
				)}
				{listbox}
			</section>
		)
	}

	return (
		<div
			ref={setScrollElement}
			className="flex-1 scrollbar-gutter-stable overflow-y-auto px-4"
		>
			<div
				className="relative mx-auto w-full max-w-3xl"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{sections.map(renderSection)}
			</div>
		</div>
	)
}
