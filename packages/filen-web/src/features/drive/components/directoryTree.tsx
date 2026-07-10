import { useTranslation } from "react-i18next"
import { ChevronRightIcon } from "lucide-react"
import type { UseQueryResult } from "@tanstack/react-query"
import { cn } from "@/lib/utils"
import { DirectoryGlyph } from "@/features/drive/components/itemIcon"
import type { DirectoryTreeChild } from "@/features/drive/queries/drive"
import { useDriveDropTarget } from "@/features/drive/hooks/useDriveDropTarget"
import { Spinner } from "@/components/ui/spinner"

// Reusable collapsible directory tree. Data wiring is fully injected (`useChildren`, `isOpen`,
// `onToggle`, `onNavigate`) so the same primitive can back the sidebar (router navigation +
// localStorage-persisted open state) and, later, the move-dialog (local uuid-stack state) with no
// change here. It renders ONLY the levels below a given parent — the owning surface renders its own
// root row and mounts this when that root is open. Lazy per level: a node's children query only fires
// once its subtree mounts (an open node renders a nested DirectoryTree; a closed one renders nothing).
//
// Roles are honest, not full aria-tree: nested `<ul>`/`<li>` lists of real buttons. The chevron is a
// button carrying `aria-expanded`; the label is a button that activates (Enter/Space native) to
// navigate. Full role="tree"/treeitem/aria-level semantics are deferred (noted for a later pass), as
// is virtualization — every mounted node renders (fine for typical trees; huge trees are future work).
export interface DirectoryTreeContext {
	// The current location's uuid chain (drive splat), for highlighting the active branch. Empty at root.
	activePath: string[]
	isOpen: (uuid: string) => boolean
	onToggle: (uuid: string) => void
	// Full uuid chain from the drive root down to (and including) the clicked node.
	onNavigate: (path: string[]) => void
	// Injected data source — named `use…` so it reads as the hook it is; called unconditionally per level.
	useChildren: (uuid: string | null) => UseQueryResult<DirectoryTreeChild[]>
	// Opt-in: each node becomes a drag-to-move drop target (a collapsed one auto-expands on hover-dwell).
	// Off by default so a non-drive reuse of this primitive (e.g. the move dialog) stays inert.
	enableDrop?: boolean
}

export interface DirectoryTreeProps {
	tree: DirectoryTreeContext
	// null = the drive root's own children (level 1); a uuid = that node's children.
	parentUuid?: string | null
	// uuid chain from the drive root down to `parentUuid` (empty for the root level).
	parentPath?: string[]
	depth?: number
}

// Indentation grows per level but stays shallow; a base inset keeps even level 1 clear of the card edge.
function levelInset(depth: number): number {
	return 8 + depth * 14
}

function arraysEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index])
}

// `path` is a strict prefix of `active` (an ancestor of the current directory), so its branch gets a
// subtle highlight while the current node itself gets the strong one.
function isStrictPrefix(path: string[], active: string[]): boolean {
	return path.length < active.length && path.every((value, index) => value === active[index])
}

export function DirectoryTree({ tree, parentUuid = null, parentPath = [], depth = 0 }: DirectoryTreeProps) {
	const { t } = useTranslation("drive")
	// Bare identifier so eslint's rules-of-hooks and React Compiler both treat this as the hook it is
	// (a member call would read as a plain function to the compiler). Called unconditionally per level.
	const { useChildren } = tree
	const query = useChildren(parentUuid)

	if (query.status === "pending") {
		return (
			<ul className="flex flex-col">
				<li
					style={{ paddingInlineStart: levelInset(depth) + 20 }}
					className="flex h-8 items-center gap-2 text-sm text-sidebar-foreground/60"
				>
					<Spinner className="size-3.5" />
				</li>
			</ul>
		)
	}

	if (query.status === "error") {
		return (
			<ul className="flex flex-col">
				<li
					style={{ paddingInlineStart: levelInset(depth) + 20 }}
					className="flex h-8 items-center text-sm text-muted-foreground"
				>
					{t("driveLoadError")}
				</li>
			</ul>
		)
	}

	if (query.data.length === 0) {
		return null
	}

	return (
		<ul className="flex flex-col gap-0.5">
			{query.data.map(child => (
				<DirectoryTreeNode
					key={child.uuid}
					child={child}
					path={[...parentPath, child.uuid]}
					depth={depth}
					tree={tree}
				/>
			))}
		</ul>
	)
}

interface DirectoryTreeNodeProps {
	child: DirectoryTreeChild
	path: string[]
	depth: number
	tree: DirectoryTreeContext
}

function DirectoryTreeNode({ child, path, depth, tree }: DirectoryTreeNodeProps) {
	const { t } = useTranslation("drive")
	const open = tree.isOpen(child.uuid)
	const active = arraysEqual(path, tree.activePath)
	const onBranch = !active && isStrictPrefix(path, tree.activePath)
	// A drag-to-move drop target for this node's directory. A collapsed node auto-expands after a
	// hover-dwell so the drag can descend into it; an open node needs no dwell.
	const drop = useDriveDropTarget({
		targetUuid: child.uuid,
		targetAncestry: path,
		disabled: !tree.enableDrop,
		onDwell: open
			? undefined
			: () => {
					tree.onToggle(child.uuid)
				}
	})

	return (
		<li>
			<div
				style={{ paddingInlineStart: levelInset(depth) }}
				onDragEnter={drop.onDragEnter}
				onDragOver={drop.onDragOver}
				onDragLeave={drop.onDragLeave}
				onDrop={drop.onDrop}
				className={cn(
					// Soft-chrome row: rounded tonal hover/active, no divider lines. app-region-no-drag keeps
					// the row clickable inside the sidebar's Electron drag region.
					"group flex h-8 items-center gap-1 rounded-xl pr-1 transition-colors app-region-no-drag",
					active
						? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
						: onBranch
							? "text-sidebar-accent-foreground hover:bg-sidebar-accent/60"
							: "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
					drop.isOver && "bg-primary/10 ring-2 ring-primary/60 ring-inset"
				)}
			>
				<button
					type="button"
					aria-expanded={open}
					aria-label={t(open ? "driveTreeCollapseNode" : "driveTreeExpandNode", { name: child.name })}
					onClick={() => {
						tree.onToggle(child.uuid)
					}}
					className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
				>
					<ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
				</button>
				<button
					type="button"
					onClick={() => {
						tree.onNavigate(path)
					}}
					className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30 [&_svg]:size-4 [&_svg]:shrink-0"
				>
					<DirectoryGlyph
						color={child.color}
						className="size-4 shrink-0"
					/>
					<span className="truncate">{child.name}</span>
				</button>
			</div>
			{open ? (
				<DirectoryTree
					tree={tree}
					parentUuid={child.uuid}
					parentPath={path}
					depth={depth + 1}
				/>
			) : null}
		</li>
	)
}
