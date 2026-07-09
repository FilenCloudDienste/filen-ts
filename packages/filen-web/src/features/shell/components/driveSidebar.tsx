import type { ComponentType } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { FolderClosedIcon, ClockIcon, StarIcon, Trash2Icon, UsersIcon, Share2Icon, Link2Icon } from "lucide-react"
import { cn } from "@/lib/utils"
import { type DriveRouteId } from "@/features/drive/lib/navigate"
import { Separator } from "@/components/ui/separator"

type IconType = ComponentType<{ className?: string }>

// The flat listing surfaces, whose routes take no params — they ride NavItem's plain `to`. The splat
// surfaces (My Drive plus the two shared roots) each take a required `_splat` param, so they can't
// share this param-less union and render through SplatNavItem instead (see DriveRouteId). `links`
// alone stays inert — its public-link listing surface ships later.
type DriveSidebarRoute = "/recents" | "/favorites" | "/trash"

// One entry per Drive information-architecture row: a flat route (plain `to`), a splat route
// (`splatTo`, rendered at its root), or an inert row (neither) — discriminated structurally so the
// whole IA stays one ordered declarative list.
type DriveSidebarItem =
	| { id: string; label: string; icon: IconType; to: DriveSidebarRoute }
	| { id: string; label: string; icon: IconType; splatTo: DriveRouteId }
	| { id: string; label: string; icon: IconType }

// Shared by NavItem and the splat links below, so all stay visually identical without recomputing the
// same static class string on every render.
const NAV_ITEM_CLASS = cn(
	"group flex h-8 w-full items-center gap-2.5 rounded-xl px-2.5 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30 [&_svg]:size-4 [&_svg]:shrink-0",
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
// match, so "/shared-in" stays highlighted for any "/shared-in/…" descent, exactly like My Drive's own
// "/drive/$" link stays active down any "/drive/…" path).
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

export function DriveSidebar() {
	const { t } = useTranslation(["drive", "common"])

	// Renders the Drive information architecture as real rows for the routed surfaces; only `links`
	// stays inert (wired up later). No fabricated directory tree or counts — only the real, stable IA
	// labels, so the sidebar reads as intentional rather than seeded with placeholder data. Built
	// inside the component rather than as a module-level constant: its labels span two namespaces (the
	// drive listing surface, plus the still-common sharing/link destinations), so each needs its own
	// resolved `t()` call rather than a single deferred key lookup.
	const items: DriveSidebarItem[] = [
		{ id: "recents", label: t("driveRecents"), icon: ClockIcon, to: "/recents" },
		{ id: "favorites", label: t("driveFavorites"), icon: StarIcon, to: "/favorites" },
		{ id: "trash", label: t("driveTrash"), icon: Trash2Icon, to: "/trash" },
		{ id: "sharedIn", label: t("common:driveSharedIn"), icon: UsersIcon, splatTo: "/shared-in/$" },
		{ id: "sharedOut", label: t("common:driveSharedOut"), icon: Share2Icon, splatTo: "/shared-out/$" },
		{ id: "links", label: t("common:driveLinks"), icon: Link2Icon }
	]

	return (
		<aside className="hidden h-svh w-52 shrink-0 flex-col bg-sidebar md:flex">
			<div className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
				<SplatNavItem
					icon={FolderClosedIcon}
					label={t("driveMyDrive")}
					to="/drive/$"
				/>
				<Separator className="my-2" />
				<div className="flex flex-col gap-0.5">
					{items.map(item =>
						"splatTo" in item ? (
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
					)}
				</div>
			</div>
			{/* Bottom block reserved for the storage-usage meter (lands in a later step); a later step
			    fills this slot. The separator is tonal only, no hard rule. */}
			<div className="shrink-0 px-3 pb-3">
				<Separator className="mb-3" />
				<div
					className="h-12"
					aria-hidden="true"
				/>
			</div>
		</aside>
	)
}
