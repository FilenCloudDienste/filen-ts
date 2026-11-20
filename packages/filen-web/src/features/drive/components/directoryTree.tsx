import {
	memo,
	useCallback,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent
} from "react"
import { useTranslation } from "react-i18next"
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual"
import { ChevronRightIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { isImeKeydown } from "@filen/shared/keymap"
import { DirectoryGlyph } from "@/features/drive/components/itemIcon"
import {
	cachedDirectoryTreeChildren,
	cachedTreeDirectory,
	useDirectoryTreeLevelsQuery,
	type DirectoryTreeChild,
	type DirectoryTreeLevel
} from "@/features/drive/queries/drive"
import { dropHighlightClass, useDriveDropTarget } from "@/features/drive/hooks/useDriveDropTarget"
import { buildTreeDragSourceProps } from "@/features/drive/lib/dnd"
import {
	flattenDirectoryTree,
	openTreeParents,
	sameTreeParents,
	treeIndexOfPath,
	treeKeyAction,
	treeRowPath,
	type FlatDirectoryTree,
	type TreeKeyAction,
	type TreeLevels,
	type TreeNodeRow,
	type TreeRow
} from "@/features/drive/lib/directoryTree.logic"
import { typeAheadBuffering, typeAheadCharacter, typeAheadIndex } from "@/features/drive/lib/listbox"
import { TREE_EXPAND_SPRING } from "@/features/drive/lib/springLoad"
import { useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"
import { hasCommandModifier } from "@/lib/rowKeys"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import { Spinner } from "@/components/ui/spinner"

// The drive sidebar's directory tree below its Cloud Drive root row, which the owning surface renders itself and
// mounts this under while that root is open, passing its open state and actions in (`isOpen`, `onToggle`,
// `onNavigate`). Lazy per level: a directory's listing is only observed while it is open and shown.
//
// The WAI-ARIA tree pattern: one Tab stop that the arrow keys, Home/End and type-ahead move (roving tabindex),
// Right/Left to open and close, Enter or Space to open the directory. Every open level is flattened into one list of visible
// rows that a single virtualizer windows, so a tree with tens of thousands of open rows mounts a screenful.
export interface DirectoryTreeContext {
	// The current location's uuid chain (drive splat), for highlighting the active branch. Empty at root.
	activePath: string[]
	isOpen: (uuid: string) => boolean
	// `parentUuid` is null for a root-level node.
	onToggle: (uuid: string, parentUuid: string | null) => void
	// A level's children finished fetching: open state kept for directories no longer among them can go,
	// once the owner knows that fetch's rows are authoritative.
	onLevelLoaded?: (parentUuid: string | null, childUuids: readonly string[]) => void
	// Full uuid chain from the drive root down to (and including) the clicked node.
	onNavigate: (path: string[]) => void
}

export interface DirectoryTreeProps {
	tree: DirectoryTreeContext
	// The sidebar's scroll area, which the tree shares with the rows around it.
	scrollElement: HTMLElement | null
	// Whether the root level is loading its first listing, for the owner's chevron to show.
	onPendingChange?: (pending: boolean) => void
}

const ROW_HEIGHT = 32
const ROW_GAP = 2
const OVERSCAN = 12
// A row brought into the window by a key mounts on a later frame; a few are plenty.
const FOCUS_FRAMES = 3
const ROOT_PARENTS: readonly (string | null)[] = [null]

// Indentation grows per level but stays shallow; a base inset keeps even level 1 clear of the card edge.
function levelInset(depth: number): number {
	return 8 + depth * 14
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index])
}

// `path` is a strict prefix of `active` (an ancestor of the current directory), so its branch gets a
// subtle highlight while the current node itself gets the strong one.
function isStrictPrefix(path: readonly string[], active: readonly string[]): boolean {
	return path.length < active.length && path.every((value, index) => value === active[index])
}

function parentUuidOf(rows: readonly TreeRow[], row: TreeRow): string | null {
	const parent = rows[row.parentIndex]

	return parent?.kind === "node" ? parent.uuid : null
}

function rowName(row: TreeRow): string {
	return row.kind === "node" ? row.name : ""
}

export function DirectoryTree({ tree, scrollElement, onPendingChange }: DirectoryTreeProps) {
	const { t } = useTranslation("drive")
	const { onLevelLoaded, isOpen } = tree
	// The levels observed: every open level whose parent's listing is held (observed, or already cached) joins at
	// once, a level whose parent's listing is still loading once that arrives; shrunk as they close.
	const [parents, setParents] = useState(ROOT_PARENTS)
	const results = useDirectoryTreeLevelsQuery(parents)
	const levels = treeLevels(parents, results)
	const wanted = openTreeParents(levels, isOpen, cachedDirectoryTreeChildren)

	// Adjusted while rendering, before any of it commits: a deeper open level joins before the tree first paints
	// without it. Settles in one more render, since the cache already resolved every level it could.
	if (!sameTreeParents(wanted, parents)) {
		setParents(wanted)
	}

	// Each level's settled listing, reported once per listing it settles on.
	const reported = useRef(new Map<string | null, readonly DirectoryTreeChild[]>())

	useEffect(() => {
		for (const [parent, level] of levels) {
			// Only a settled fetch: cached data may predate a directory that was created and opened since.
			if (
				level.status === "success" &&
				!level.isFetching &&
				level.data !== undefined &&
				reported.current.get(parent) !== level.data
			) {
				reported.current.set(parent, level.data)
				onLevelLoaded?.(
					parent,
					level.data.map(child => child.uuid)
				)
			}
		}
	}, [levels, onLevelLoaded])

	const pending = levels.get(null)?.status !== "success" && levels.get(null)?.status !== "error"

	// Layout, not passive: the owner's chevron turns into a spinner before the open state first paints.
	useLayoutEffect(() => {
		if (!pending || onPendingChange === undefined) {
			return
		}

		onPendingChange(true)

		return () => {
			onPendingChange(false)
		}
	}, [pending, onPendingChange])

	const flat = flattenDirectoryTree(levels, isOpen)
	const activeIndex = treeIndexOfPath(flat, tree.activePath)

	// The owner's chevron shows the load, so a level that turns out empty never changes the tree's height.
	if (flat.rows.length === 0) {
		return null
	}

	// The root level failed: a tree with no node in it would hide the line from a screen reader's focus mode.
	if (flat.rows[0]?.kind === "error") {
		return <p className="flex h-8 items-center ps-7 text-sm text-muted-foreground">{t("driveLoadError")}</p>
	}

	return (
		<DirectoryTreeRows
			flat={flat}
			activeIndex={activeIndex}
			tree={tree}
			scrollElement={scrollElement}
		/>
	)
}

function treeLevels(parents: readonly (string | null)[], results: readonly DirectoryTreeLevel[]): TreeLevels {
	const levels = new Map<string | null, DirectoryTreeLevel>()

	parents.forEach((parent, index) => {
		const level = results[index]

		if (level !== undefined) {
			levels.set(parent, level)
		}
	})

	return levels
}

interface DirectoryTreeRowsProps {
	flat: FlatDirectoryTree
	// The current directory's row, -1 when it is not shown.
	activeIndex: number
	tree: DirectoryTreeContext
	scrollElement: HTMLElement | null
}

// Owns the virtualizer, which opts its host out of the React Compiler and re-renders it on every range change while
// scrolling; split out so DirectoryTree and each row still compile, and those renders stay here.
function DirectoryTreeRows({ flat, activeIndex, tree, scrollElement }: DirectoryTreeRowsProps) {
	const { t } = useTranslation("drive")
	const { rows } = flat
	const [treeElement, setTreeElement] = useState<HTMLDivElement | null>(null)
	// Where the tree starts within the scroll area (below the Cloud Drive row), which the rows are offset from.
	const [scrollMargin, setScrollMargin] = useState(0)
	// The node last focused, which keeps the Tab stop while it is shown.
	const [focusKey, setFocusKey] = useState<string | null>(null)
	// Type-ahead's prefix: only the keydown reads it, and nothing renders from it.
	const typedText = useRef("")
	const typedAt = useRef(0)

	const focusedIndex = focusKey === null ? -1 : (flat.indexByUuid.get(focusKey) ?? -1)
	const tabStop = focusedIndex !== -1 ? focusedIndex : activeIndex !== -1 ? activeIndex : rows[0]?.kind === "node" ? 0 : -1

	useLayoutEffect(() => {
		if (scrollElement === null || treeElement === null) {
			return
		}

		setScrollMargin(treeElement.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop)
	}, [scrollElement, treeElement])

	// Memoized by hand (useVirtualizer opts this component out of the React Compiler): a new function re-lays or
	// re-ranges every row, so each changes with what it reads and nothing else. The Tab stop stays mounted wherever
	// the window is, so Tab always reaches the tree.
	const rangeExtractor = useCallback(
		(range: Range) => {
			const indexes = defaultRangeExtractor(range)

			if (tabStop === -1 || indexes.includes(tabStop)) {
				return indexes
			}

			return tabStop < (indexes[0] ?? 0) ? [tabStop, ...indexes] : [...indexes, tabStop]
		},
		[tabStop]
	)
	const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows])

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => ROW_HEIGHT,
		gap: ROW_GAP,
		overscan: OVERSCAN,
		scrollMargin,
		getItemKey,
		rangeExtractor
	})

	// The current directory's row is scrolled into view when it becomes another one (a navigation, or the row first
	// showing as its levels load) or the scroll area arrives after it (the virtualizer drops a scroll it has no element
	// for), not when the tree merely changes around it.
	const activeKey = rows[activeIndex]?.key
	const revealActive = useEffectEvent(() => {
		virtualizer.scrollToIndex(activeIndex)
	})

	useEffect(() => {
		if (activeKey !== undefined && scrollElement !== null) {
			revealActive()
		}
	}, [activeKey, scrollElement])

	function focusRow(list: HTMLElement, index: number, framesLeft: number): void {
		const row = list.querySelector<HTMLElement>(`[role="treeitem"][data-index="${String(index)}"]`)

		if (row !== null) {
			row.focus()
		} else if (framesLeft > 0) {
			requestAnimationFrame(() => {
				focusRow(list, index, framesLeft - 1)
			})
		}
	}

	function moveFocus(list: HTMLElement, index: number): void {
		const row = rows[index]

		if (row?.kind !== "node") {
			return
		}

		setFocusKey(row.key)
		virtualizer.scrollToIndex(index)
		focusRow(list, index, FOCUS_FRAMES)
	}

	function runAction(list: HTMLElement, action: TreeKeyAction): void {
		const row = rows[action.index]

		if (row?.kind !== "node") {
			return
		}

		if (action.kind === "toggle") {
			tree.onToggle(row.uuid, parentUuidOf(rows, row))
		} else if (action.kind === "open") {
			tree.onNavigate(treeRowPath(rows, action.index))
		} else {
			moveFocus(list, action.index)
		}
	}

	// Stopped short of the page's own document-wide shortcuts (a bare letter a user bound, the listing's Enter).
	function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
		if (event.defaultPrevented || isImeKeydown(event.nativeEvent)) {
			return
		}

		const target = event.target instanceof HTMLElement && event.target.getAttribute("role") === "treeitem" ? event.target : null
		const from = target === null ? -1 : Number(target.dataset["index"] ?? "-1")

		if (from === -1) {
			return
		}

		const list = event.currentTarget
		const now = Date.now()
		const buffering = typeAheadBuffering(typedText.current, typedAt.current, now)
		// Space continues a type-ahead prefix ("my files"); only on its own does it open the directory.
		const action =
			event.shiftKey || hasCommandModifier(event) || (event.key === " " && buffering) ? null : treeKeyAction(rows, from, event.key)

		if (action !== null) {
			event.preventDefault()
			event.stopPropagation()
			runAction(list, action)

			return
		}

		const character = typeAheadCharacter(event, buffering)

		if (character === null) {
			return
		}

		event.preventDefault()
		event.stopPropagation()
		typedText.current = buffering ? typedText.current + character : character
		typedAt.current = now

		const index = typeAheadIndex(rows, rowName, from, typedText.current, !buffering)

		if (index !== -1) {
			moveFocus(list, index)
		}
	}

	return (
		<div
			ref={setTreeElement}
			role="tree"
			aria-label={t("driveTreeLabel")}
			onKeyDown={handleKeyDown}
			className="relative w-full"
			style={{ height: virtualizer.getTotalSize() }}
		>
			{virtualizer.getVirtualItems().map(item => {
				const row = rows[item.index]

				if (row === undefined) {
					return null
				}

				const top = item.start - scrollMargin

				return row.kind === "node" ? (
					<DirectoryTreeNode
						key={item.key}
						rows={rows}
						row={row}
						index={item.index}
						top={top}
						tabbable={item.index === tabStop}
						tree={tree}
						onFocusKey={setFocusKey}
					/>
				) : (
					// Presentational, not a node: this line is an error, which the arrow keys pass over.
					<div
						key={item.key}
						role="none"
						style={{ paddingInlineStart: levelInset(row.depth) + 20, transform: `translateY(${String(top)}px)` }}
						className="absolute top-0 left-0 flex h-8 w-full items-center text-sm text-muted-foreground"
					>
						{t("driveLoadError")}
					</div>
				)
			})}
		</div>
	)
}

// The disclosure button of the owning surface's root row. While the tree it discloses loads its first listing, a
// spinner stands in for the chevron (silent: the row's aria-busy carries it).
export function DirectoryTreeChevron({
	name,
	open,
	loading,
	onToggle,
	className
}: {
	name: string
	open: boolean
	loading: boolean
	onToggle: () => void
	className?: string
}) {
	const { t } = useTranslation("drive")

	return (
		<button
			type="button"
			aria-expanded={open}
			aria-label={t(open ? "driveTreeCollapseNode" : "driveTreeExpandNode", { name })}
			onClick={onToggle}
			className={cn(
				"flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground focus-ring outline-none hover:text-foreground",
				className
			)}
		>
			<ChevronGlyph
				open={open}
				loading={loading}
			/>
		</button>
	)
}

function ChevronGlyph({ open, loading }: { open: boolean; loading: boolean }) {
	return loading ? (
		<Spinner
			aria-hidden
			className="size-3.5"
		/>
	) : (
		<ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
	)
}

interface DirectoryTreeNodeProps {
	rows: readonly TreeRow[]
	row: TreeNodeRow
	index: number
	// Offset from the tree's top.
	top: number
	// The tree's one Tab stop.
	tabbable: boolean
	tree: DirectoryTreeContext
	onFocusKey: (key: string) => void
}

// Memoized: DirectoryTreeRows runs the virtualizer, which opts it out of the React Compiler and re-renders it on every
// range change while scrolling; its props hold still then, so only a row whose own props changed renders again.
const DirectoryTreeNode = memo(function DirectoryTreeNode({ rows, row, index, top, tabbable, tree, onFocusKey }: DirectoryTreeNodeProps) {
	const path = treeRowPath(rows, index)
	const active = arraysEqual(path, tree.activePath)
	const onBranch = !active && isStrictPrefix(path, tree.activePath)
	const parentUuid = parentUuidOf(rows, row)
	// A drag-to-move drop target for this node's directory that also takes uploads from the system. A
	// collapsed node springs open (expands) after a short rest so the drag can descend into it; an open
	// node has nothing to spring.
	const drop = useDriveDropTarget({
		targetUuid: row.uuid,
		targetAncestry: path,
		targetName: row.name,
		acceptFiles: true,
		spring: row.open
			? undefined
			: {
					timing: TREE_EXPAND_SPRING,
					open: () => {
						tree.onToggle(row.uuid, parentUuid)
					}
				}
	})

	// A drag source for its own directory (move, or copy with the copy modifier).
	const dragSource = buildTreeDragSourceProps(() => cachedTreeDirectory(parentUuid, row.uuid))
	// Cut for a later paste: dimmed, as its listing row is, until the paste or the next copy/cut.
	const cut = useDriveClipboardStore(state => state.cutUuids.has(row.uuid))

	return (
		<div
			role="treeitem"
			// The rows are one flat window, so each says where it sits in the tree.
			aria-level={row.depth + 1}
			aria-setsize={row.setSize}
			aria-posinset={row.posInSet}
			aria-expanded={row.open}
			// The routed directory is the tree's selection.
			aria-selected={active}
			aria-busy={row.loading || undefined}
			tabIndex={tabbable ? 0 : -1}
			data-index={index}
			// The node's root-to-node chain, for the sidebar's one tree menu and its clipboard shortcuts
			// (directoryTreeMenu.tsx).
			data-tree-path={path.join("/")}
			data-cut={cut ? "" : undefined}
			style={{ paddingInlineStart: levelInset(row.depth), transform: `translateY(${String(top)}px)` }}
			ref={element => {
				drop.attach(element)
			}}
			onPointerDown={dragSource.onPointerDown}
			onFocus={event => {
				if (event.target === event.currentTarget) {
					onFocusKey(row.key)
				}
			}}
			onClick={() => {
				tree.onNavigate(path)
			}}
			{...drop.handlers}
			className={cn(
				// Soft-chrome row: rounded tonal hover/active, no divider lines. app-region-no-drag keeps
				// the row clickable inside the sidebar's Electron drag region.
				"group absolute top-0 left-0 flex h-8 w-full cursor-default items-center gap-1 rounded-xl pr-1 text-sm focus-ring transition-colors outline-none app-region-no-drag [&_svg]:shrink-0",
				active
					? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
					: onBranch
						? "text-sidebar-accent-foreground hover:bg-sidebar-accent/60 data-menu-open:bg-sidebar-accent/60"
						: "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground data-menu-open:bg-sidebar-accent/60",
				dropHighlightClass(drop)
			)}
		>
			{/* A pointer's disclosure; the keyboard's is Right and Left on the row. */}
			<span
				aria-hidden="true"
				data-tree-chevron=""
				onClick={event => {
					event.stopPropagation()
					tree.onToggle(row.uuid, parentUuid)
				}}
				className="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
			>
				<ChevronGlyph
					open={row.open}
					loading={row.loading}
				/>
			</span>
			<span className={cn("flex min-w-0 flex-1 items-center gap-2 py-1", cut && "opacity-50")}>
				<DirectoryGlyph
					color={row.color}
					className="size-4 shrink-0"
				/>
				<span className="truncate">{row.name}</span>
			</span>
		</div>
	)
})
