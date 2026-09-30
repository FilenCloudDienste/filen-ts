import { type ComponentType } from "react"
import { useTranslation } from "react-i18next"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { ChevronRightIcon, FolderClosedIcon, ClockIcon, StarIcon, Trash2Icon, UsersIcon, Share2Icon, Link2Icon } from "lucide-react"
import { cn } from "@filen/shared"
import { type DriveRouteId, splatToUuids } from "@/features/drive/lib/navigate"
import { useDirectoryTreeChildrenQuery } from "@/features/drive/queries/drive"
import { isTreeNodeOpen, TREE_ROOT_KEY, useDirectoryTreeStore } from "@/features/drive/store/useDirectoryTreeStore"
import { DirectoryTree, type DirectoryTreeContext } from "@/features/drive/components/directoryTree"
import { DirectoryTreeMenu } from "@/features/drive/components/directoryTreeMenu"
import { dropHighlightClass, useDriveDropTarget } from "@/features/drive/hooks/useDriveDropTarget"
import { TREE_EXPAND_SPRING } from "@/features/drive/lib/springLoad"
import { StorageMeter } from "@/features/shell/components/storageMeter"
import { ResizableSidebarPanel } from "@/features/shell/components/sidebarPanel"
import { SIDEBAR_NAV_ITEM_CLASS } from "@/features/shell/lib/sidebarNavItem"
import { pathIsUnder } from "@/features/shell/lib/appShell.logic"
import { Separator } from "@/components/ui/separator"

type IconType = ComponentType<{ className?: string }>

// The flat listing surfaces, whose routes take no params — they ride NavItem's plain `to`. The splat
// surfaces (the two shared roots) each take a required `_splat` param, so they can't share this
// param-less union and render through SplatNavItem instead (see DriveRouteId). `/links` is flat too
// (listLinkedItems has no nested path of its own), so it joins this union rather than SplatNavItem's.
type DriveSidebarRoute = "/recents" | "/favorites" | "/trash" | "/links"

// One entry per virtual-root row: a flat route (plain `to`) or a splat route (`splatTo`, rendered at its
// root) — discriminated structurally so the whole IA stays one ordered declarative list.
type DriveSidebarItem =
	| { id: string; label: string; icon: IconType; to: DriveSidebarRoute }
	| { id: string; label: string; icon: IconType; splatTo: DriveRouteId }

// Muted group header over each virtual-root cluster ("Other", "Shared").
const GROUP_HEADER_CLASS = "px-2.5 pt-4 pb-1 text-xs font-medium text-muted-foreground/80"

// TanStack Router stamps `data-status="active"` and `aria-current="page"` on the `<Link>` automatically
// whenever the current location matches.
function NavItem({ icon: Icon, label, to }: { icon: IconType; label: string; to: DriveSidebarRoute }) {
	return (
		<Link
			to={to}
			className={SIDEBAR_NAV_ITEM_CLASS}
		>
			<Icon className="text-muted-foreground group-data-[status=active]:text-primary" />
			<span className="truncate">{label}</span>
		</Link>
	)
}

// A splat route always linked at its own root (empty splat). Same active-styling contract as NavItem —
// TanStack stamps `data-status="active"` for any nested path under the route (a plain pathname-prefix
// match, so "/shared-in" stays highlighted for any "/shared-in/…" descent).
function SplatNavItem({ icon: Icon, label, to }: { icon: IconType; label: string; to: DriveRouteId }) {
	return (
		<Link
			to={to}
			params={{ _splat: "" }}
			className={SIDEBAR_NAV_ITEM_CLASS}
		>
			<Icon className="text-muted-foreground group-data-[status=active]:text-primary" />
			<span className="truncate">{label}</span>
		</Link>
	)
}

// The Cloud Drive root row: a chevron disclosing the whole tree, plus a real `<Link>` navigating to
// the drive root (a Link, not a button, so it keeps TanStack's automatic active status and stays the
// sidebar's stable "Cloud Drive" landmark link). Its own open flag rides TREE_ROOT_KEY.
function CloudDriveRoot({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
	const { t } = useTranslation("drive")
	// The drive root as a drag-to-move drop target (empty ancestry). A collapsed root springs open
	// (expands) on a short rest, same as any node below it.
	const drop = useDriveDropTarget({
		targetUuid: null,
		targetAncestry: [],
		targetName: label,
		spring: open ? undefined : { timing: TREE_EXPAND_SPRING, open: onToggle },
		acceptFiles: true
	})

	return (
		<div
			// The root's chain is empty — see directoryTreeMenu.tsx.
			data-tree-path=""
			{...drop.handlers}
			className={cn(
				"group flex h-8 items-center gap-1 rounded-xl pr-1 transition-colors app-region-no-drag hover:bg-sidebar-accent/60 data-menu-open:bg-sidebar-accent/60",
				dropHighlightClass(drop)
			)}
		>
			<button
				type="button"
				aria-expanded={open}
				aria-label={t(open ? "driveTreeCollapseNode" : "driveTreeExpandNode", { name: label })}
				onClick={onToggle}
				className="ml-2 flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground focus-ring outline-none hover:text-foreground"
			>
				<ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
			</button>
			<Link
				to="/drive/$"
				params={{ _splat: "" }}
				className="group/link flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-left text-sm text-sidebar-foreground/80 focus-ring transition-colors outline-none data-[status=active]:font-medium data-[status=active]:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0"
			>
				<FolderClosedIcon className="text-muted-foreground group-data-[status=active]/link:text-primary" />
				<span className="truncate">{label}</span>
			</Link>
		</div>
	)
}

// Outside the component: a hook referenced as a value inside it makes the React Compiler skip DriveSidebar.
const TREE_DATA = { useChildren: useDirectoryTreeChildrenQuery }
// Shared so the tree context keeps its identity across non-drive navigations.
const NO_ACTIVE_PATH: string[] = []

export function DriveSidebar() {
	const { t } = useTranslation(["drive", "common"])
	const navigate = useNavigate()

	// The current location drives the tree's active-branch highlight. The drive route is a "/drive/$"
	// splat, so its pathname is "/drive" at the root and "/drive/<a>/<b>" nested; strip the prefix back
	// to the raw splat and split into its uuid chain. Any non-drive route highlights nothing.
	const pathname = useRouterState({ select: state => state.location.pathname })
	const onDrive = pathIsUnder(pathname, "/drive")
	const activePath = onDrive ? splatToUuids(pathname.replace(/^\/drive\/?/, "")) : NO_ACTIVE_PATH

	const openMap = useDirectoryTreeStore(state => state.open)
	const toggle = useDirectoryTreeStore(state => state.toggle)
	const reconcileLevel = useDirectoryTreeStore(state => state.reconcileLevel)
	const rootOpen = isTreeNodeOpen(openMap, TREE_ROOT_KEY)

	function navigateTo(path: string[]): void {
		void navigate({ to: "/drive/$", params: { _splat: path.join("/") } })
	}

	const tree: DirectoryTreeContext = {
		...TREE_DATA,
		activePath,
		isOpen: uuid => isTreeNodeOpen(openMap, uuid),
		onToggle: (uuid, parentUuid) => {
			toggle(uuid, parentUuid ?? TREE_ROOT_KEY)
		},
		onLevelLoaded: (parentUuid, childUuids) => {
			reconcileLevel(parentUuid ?? TREE_ROOT_KEY, childUuids)
		},
		onNavigate: navigateTo
	}

	// Virtual roots in two groups, each under a muted header. Built inside the component rather than as
	// module-level constants: labels span two namespaces (the drive listing surface plus the
	// still-common sharing/link destinations), so each needs its own resolved `t()` call.
	const otherItems: DriveSidebarItem[] = [
		{ id: "recents", label: t("driveRecents"), icon: ClockIcon, to: "/recents" },
		{ id: "favorites", label: t("driveFavorites"), icon: StarIcon, to: "/favorites" },
		{ id: "trash", label: t("driveTrash"), icon: Trash2Icon, to: "/trash" }
	]
	const sharedItems: DriveSidebarItem[] = [
		{ id: "sharedIn", label: t("common:driveSharedIn"), icon: UsersIcon, splatTo: "/shared-in/$" },
		{ id: "sharedOut", label: t("common:driveSharedOut"), icon: Share2Icon, splatTo: "/shared-out/$" },
		{ id: "links", label: t("common:driveLinks"), icon: Link2Icon, to: "/links" }
	]

	function renderItem(item: DriveSidebarItem) {
		return "splatTo" in item ? (
			<SplatNavItem
				key={item.id}
				icon={item.icon}
				label={item.label}
				to={item.splatTo}
			/>
		) : (
			<NavItem
				key={item.id}
				icon={item.icon}
				label={item.label}
				to={item.to}
			/>
		)
	}

	return (
		<ResizableSidebarPanel
			module="drive"
			resizeLabel={t("driveSidebarResize")}
		>
			{/* Pinned outside the scroll area. Inside that flex column its `truncate` (overflow: hidden)
				    zeroes its automatic minimum height, so an overflowing tree squeezes it and the first row
				    paints over its text. */}
			<h2 className="shrink-0 truncate px-5.5 pt-4 pb-1.5 text-[15px] font-semibold">{t("driveMyDrive")}</h2>
			{/* pt-1 keeps the first row's focus ring clear of the scroll area's clipping edge. */}
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-1 pb-3">
				{/* A nested disclosure list, deliberately NOT role="tree": the ARIA tree pattern owes a
					roving-tabindex/arrow-key focus model this sidebar does not implement, and claiming the
					role without it sends a screen-reader user into an interaction mode whose items never take
					focus. Plain list semantics describe what is really here — each row's chevron carries its
					own aria-expanded, and the subtree it discloses is nested inside its own item. */}
				<DirectoryTreeMenu
					onNavigate={navigateTo}
					render={
						<ul
							aria-label={t("driveTreeLabel")}
							className="flex flex-col gap-0.5"
						>
							<li className="flex flex-col gap-0.5">
								<CloudDriveRoot
									label={t("driveMyDrive")}
									open={rootOpen}
									onToggle={() => {
										toggle(TREE_ROOT_KEY, TREE_ROOT_KEY)
									}}
								/>
								{rootOpen ? <DirectoryTree tree={tree} /> : null}
							</li>
						</ul>
					}
				/>
				<p className={GROUP_HEADER_CLASS}>{t("driveGroupOther")}</p>
				<div className="flex flex-col gap-0.5">{otherItems.map(renderItem)}</div>
				<p className={GROUP_HEADER_CLASS}>{t("driveGroupShared")}</p>
				<div className="flex flex-col gap-0.5">{sharedItems.map(renderItem)}</div>
			</div>
			{/* Bottom block: storage-usage meter above a tonal-only separator (no hard rule). */}
			<div className="shrink-0 px-3 pb-3">
				<Separator className="mb-3 bg-border/50" />
				<StorageMeter />
			</div>
		</ResizableSidebarPanel>
	)
}
