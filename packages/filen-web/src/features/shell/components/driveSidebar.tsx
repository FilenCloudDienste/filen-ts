import type { ComponentType } from "react"
import { useTranslation } from "react-i18next"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { ChevronRightIcon, FolderClosedIcon, ClockIcon, StarIcon, Trash2Icon, UsersIcon, Share2Icon, Link2Icon } from "lucide-react"
import { cn } from "@/lib/utils"
import { type DriveRouteId, splatToUuids } from "@/features/drive/lib/navigate"
import { useDirectoryTreeChildrenQuery } from "@/features/drive/queries/drive"
import { useDirectoryTreeStore } from "@/features/drive/store/useDirectoryTreeStore"
import { DirectoryTree, type DirectoryTreeContext } from "@/features/drive/components/directoryTree"
import { StorageMeter } from "@/features/shell/components/storageMeter"
import { Separator } from "@/components/ui/separator"

type IconType = ComponentType<{ className?: string }>

// The flat listing surfaces, whose routes take no params — they ride NavItem's plain `to`. The splat
// surfaces (the two shared roots) each take a required `_splat` param, so they can't share this
// param-less union and render through SplatNavItem instead (see DriveRouteId). `links` alone stays
// inert — its public-link listing surface ships later.
type DriveSidebarRoute = "/recents" | "/favorites" | "/trash"

// One entry per virtual-root row: a flat route (plain `to`), a splat route (`splatTo`, rendered at its
// root), or an inert row (neither) — discriminated structurally so the whole IA stays one ordered
// declarative list.
type DriveSidebarItem =
	| { id: string; label: string; icon: IconType; to: DriveSidebarRoute }
	| { id: string; label: string; icon: IconType; splatTo: DriveRouteId }
	| { id: string; label: string; icon: IconType }

// Persisted open-state key for the Cloud Drive root row. Directory uuids are real UUIDs, never the
// literal "root", so this sentinel can share the tree's uuid-keyed open map with zero collision — and
// keeping the root's open flag under its OWN key is what lets collapsing the root leave every
// descendant's recorded state untouched (see useDirectoryTreeStore).
const ROOT_KEY = "root"

// Muted group header over each virtual-root cluster ("Other", "Shared").
const GROUP_HEADER_CLASS = "px-2.5 pt-4 pb-1 text-xs font-medium text-muted-foreground/80"

// Shared by NavItem and the splat links below, so all stay visually identical without recomputing the
// same static class string on every render.
const NAV_ITEM_CLASS = cn(
	// app-region-no-drag: every row is a real click target inside the sidebar's own drag region (see
	// the <aside> below).
	"group flex h-8 w-full items-center gap-2.5 rounded-xl px-2.5 text-sm transition-colors outline-none app-region-no-drag focus-visible:ring-3 focus-visible:ring-ring/30 [&_svg]:size-4 [&_svg]:shrink-0",
	"text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
	"data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium data-[status=active]:text-sidebar-accent-foreground"
)

// `to` present renders a real `<Link>` — TanStack Router stamps `data-status="active"` and
// `aria-current="page"` on it automatically whenever the current location matches. `to` absent
// renders the original inert row — `links` has no destination yet.
function NavItem({ icon: Icon, label, to }: { icon: IconType; label: string; to?: DriveSidebarRoute | undefined }) {
	if (to === undefined) {
		return (
			<button
				type="button"
				className={NAV_ITEM_CLASS}
			>
				<Icon className="text-muted-foreground" />
				<span className="truncate">{label}</span>
			</button>
		)
	}

	return (
		<Link
			to={to}
			className={NAV_ITEM_CLASS}
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
			className={NAV_ITEM_CLASS}
		>
			<Icon className="text-muted-foreground group-data-[status=active]:text-primary" />
			<span className="truncate">{label}</span>
		</Link>
	)
}

// The Cloud Drive root row: a chevron toggling the whole tree open, plus a real `<Link>` navigating to
// the drive root (kept a Link — not a tree button — so it keeps TanStack's automatic active status and
// stays the sidebar's stable "Cloud Drive" landmark link). Its own open flag rides ROOT_KEY.
function CloudDriveRoot({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
	const { t } = useTranslation("drive")

	return (
		<div className="group flex h-8 items-center gap-1 rounded-xl pr-1 transition-colors app-region-no-drag hover:bg-sidebar-accent/60">
			<button
				type="button"
				aria-expanded={open}
				aria-label={t(open ? "driveTreeCollapseNode" : "driveTreeExpandNode", { name: label })}
				onClick={onToggle}
				className="ml-2 flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
			>
				<ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
			</button>
			<Link
				to="/drive/$"
				params={{ _splat: "" }}
				className="group/link flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-left text-sm text-sidebar-foreground/80 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30 data-[status=active]:font-medium data-[status=active]:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0"
			>
				<FolderClosedIcon className="text-muted-foreground group-data-[status=active]/link:text-primary" />
				<span className="truncate">{label}</span>
			</Link>
		</div>
	)
}

export function DriveSidebar() {
	const { t } = useTranslation(["drive", "common"])
	const navigate = useNavigate()

	// The current location drives the tree's active-branch highlight. The drive route is a "/drive/$"
	// splat, so its pathname is "/drive" at the root and "/drive/<a>/<b>" nested; strip the prefix back
	// to the raw splat and split into its uuid chain. Any non-drive route highlights nothing.
	const pathname = useRouterState({ select: state => state.location.pathname })
	const onDrive = pathname === "/drive" || pathname.startsWith("/drive/")
	const activePath = onDrive ? splatToUuids(pathname.replace(/^\/drive\/?/, "")) : []

	const openMap = useDirectoryTreeStore(state => state.open)
	const toggle = useDirectoryTreeStore(state => state.toggle)
	// Default expanded so the tree reads as present; a persisted `false` still collapses it.
	const rootOpen = openMap[ROOT_KEY] ?? true

	const tree: DirectoryTreeContext = {
		activePath,
		isOpen: uuid => openMap[uuid] ?? false,
		onToggle: toggle,
		onNavigate: path => {
			void navigate({ to: "/drive/$", params: { _splat: path.join("/") } })
		},
		useChildren: useDirectoryTreeChildrenQuery
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
		{ id: "links", label: t("common:driveLinks"), icon: Link2Icon }
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
				to={"to" in item ? item.to : undefined}
			/>
		)
	}

	return (
		<aside
			// Drag region (Electron plumbing): inert in a plain browser (-webkit-app-region is ignored
			// outside Chromium/Electron). Interactive descendants opt back out with app-region-no-drag.
			className="hidden w-48 shrink-0 flex-col rounded-xl bg-sidebar app-region-drag md:flex"
		>
			<div className="flex flex-1 flex-col overflow-y-auto p-3">
				<h2 className="truncate px-2.5 pt-1 pb-2.5 text-[15px] font-semibold">{t("driveMyDrive")}</h2>
				<div className="flex flex-col gap-0.5">
					<CloudDriveRoot
						label={t("driveMyDrive")}
						open={rootOpen}
						onToggle={() => {
							toggle(ROOT_KEY)
						}}
					/>
					{rootOpen ? <DirectoryTree tree={tree} /> : null}
				</div>
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
		</aside>
	)
}
