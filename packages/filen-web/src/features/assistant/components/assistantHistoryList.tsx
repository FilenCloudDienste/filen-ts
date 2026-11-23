import type { CSSProperties, ReactNode } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import type { ConversationMeta, HistoryGroup } from "@/features/assistant/store/history.logic"

// A row's button (text-sm in py-1.5) and the gap-0.5 below every row but a group's last.
const ROW_HEIGHT = 32
const ROW_GAP = 2
// A group's heading: text-xs in pt-3 pb-1.
const HEADING_HEIGHT = 32
const OVERSCAN = 8

type FlatItem = { kind: "head"; group: number } | { kind: "row"; group: number; index: number }

interface GroupLayout {
	headIndex: number
	count: number
}

function rowsHeight(count: number): number {
	return count === 0 ? 0 : count * (ROW_HEIGHT + ROW_GAP) - ROW_GAP
}

// The saved conversations as one window over a flat list of day headings and rows, each day still its own labelled
// section and list: a history of hundreds mounts what is in view. Every height is fixed (titles truncate), so the
// layout is known without measuring. Its own file, as useVirtualizer opts it out of the React Compiler.
export function AssistantHistoryList({
	scrollElement,
	groups,
	label,
	groupLabel,
	renderRow
}: {
	scrollElement: HTMLElement | null
	groups: readonly { group: HistoryGroup; conversations: readonly ConversationMeta[] }[]
	label: string
	groupLabel: (group: HistoryGroup) => string
	// A row's <li>, placed by `style` (absolute, in its list).
	renderRow: (meta: ConversationMeta, style: CSSProperties) => ReactNode
}) {
	const items: FlatItem[] = []
	const layouts: GroupLayout[] = []

	for (const [groupIndex, { conversations }] of groups.entries()) {
		layouts.push({ headIndex: items.length, count: conversations.length })
		items.push({ kind: "head", group: groupIndex })

		for (let index = 0; index < conversations.length; index++) {
			items.push({ kind: "row", group: groupIndex, index })
		}
	}

	const virtualizer = useVirtualizer({
		count: items.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: index => {
			const item = items[index]

			if (item === undefined) {
				return 0
			}

			if (item.kind === "head") {
				return HEADING_HEIGHT
			}

			return item.index === (layouts[item.group]?.count ?? 0) - 1 ? ROW_HEIGHT : ROW_HEIGHT + ROW_GAP
		},
		overscan: OVERSCAN,
		getItemKey: index => {
			const item = items[index]
			const entry = item === undefined ? undefined : groups[item.group]

			if (item === undefined || entry === undefined) {
				return index
			}

			return item.kind === "head" ? `head:${entry.group}` : (entry.conversations[item.index]?.id ?? index)
		}
	})

	const virtualItems = virtualizer.getVirtualItems()

	function renderGroup({ group, conversations }: (typeof groups)[number], groupIndex: number): ReactNode {
		const layout = layouts[groupIndex]

		if (layout === undefined) {
			return null
		}

		const top = virtualizer.measurementsCache[layout.headIndex]?.start ?? 0
		const rowsTop = top + HEADING_HEIGHT
		const height = rowsHeight(conversations.length)
		const rows: ReactNode[] = []

		for (const virtualRow of virtualItems) {
			const item = items[virtualRow.index]
			const meta = item?.kind === "row" && item.group === groupIndex ? conversations[item.index] : undefined

			if (meta === undefined) {
				continue
			}

			rows.push(
				renderRow(meta, {
					position: "absolute",
					top: 0,
					left: 0,
					width: "100%",
					height: ROW_HEIGHT,
					transform: `translateY(${String(virtualRow.start - rowsTop)}px)`
				})
			)
		}

		return (
			<section
				key={group}
				aria-labelledby={`assistant-history-${group}`}
				className="absolute top-0 left-0 w-full"
				style={{ height: HEADING_HEIGHT + height, transform: `translateY(${String(top)}px)` }}
			>
				<h3
					id={`assistant-history-${group}`}
					className="truncate px-2.5 pt-3 pb-1 text-xs font-semibold text-muted-foreground"
				>
					{groupLabel(group)}
				</h3>
				<ul
					className="relative"
					style={{ height }}
				>
					{rows}
				</ul>
			</section>
		)
	}

	return (
		<nav
			aria-label={label}
			className="relative w-full"
			style={{ height: virtualizer.getTotalSize() }}
		>
			{groups.map(renderGroup)}
		</nav>
	)
}
