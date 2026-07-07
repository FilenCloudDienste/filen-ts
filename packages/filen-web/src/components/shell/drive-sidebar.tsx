import type { ComponentType } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { FolderClosedIcon, ClockIcon, StarIcon, Trash2Icon, UsersIcon, Share2Icon, Link2Icon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Separator } from "@/components/ui/separator"

type IconType = ComponentType<{ className?: string }>

// The four listing surfaces wired to real routes in this slice; sharedIn/sharedOut/links have no
// route yet (a later drive sub-slice — see preferences.ts's DriveVariant scope note) and stay
// inert below.
type DriveSidebarRoute = "/drive" | "/recents" | "/favorites" | "/trash"

// `to` present renders a real `<Link>` — TanStack Router stamps `data-status="active"` and
// `aria-current="page"` on it automatically whenever the current location matches (prefix match by
// default, so "/drive" stays active while browsing any /drive/$uuid subdirectory too). `to` absent
// renders the original inert row — sharedIn/sharedOut/links have no destination yet.
function NavItem({ icon: Icon, label, to }: { icon: IconType; label: string; to?: DriveSidebarRoute | undefined }) {
	const className = cn(
		"group flex h-8 w-full items-center gap-2.5 rounded-xl px-2.5 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30 [&_svg]:size-4 [&_svg]:shrink-0",
		"text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
		"data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium data-[status=active]:text-sidebar-accent-foreground"
	)

	if (to === undefined) {
		return (
			<button
				type="button"
				className={className}
			>
				<Icon className="text-muted-foreground" />
				<span className="truncate">{label}</span>
			</button>
		)
	}

	return (
		<Link
			to={to}
			className={className}
		>
			<Icon className="text-muted-foreground group-data-[status=active]:text-primary" />
			<span className="truncate">{label}</span>
		</Link>
	)
}

export function DriveSidebar() {
	const { t } = useTranslation(["drive", "common"])

	// Renders the Drive information architecture as real rows for the four routed surfaces; the
	// sharing/link destinations stay inert (wired up later). No fabricated directory tree or counts
	// — only the real, stable IA labels, so the sidebar reads as intentional rather than seeded with
	// placeholder data. Built inside the component rather than as a module-level constant: its
	// labels span two namespaces (the drive listing surface, plus the sharing/link destinations
	// still in common until their own listing surface ships), so each needs its own resolved `t()`
	// call rather than a single deferred key lookup.
	const items: { id: string; label: string; icon: IconType; to?: DriveSidebarRoute }[] = [
		{ id: "recents", label: t("driveRecents"), icon: ClockIcon, to: "/recents" },
		{ id: "favorites", label: t("driveFavorites"), icon: StarIcon, to: "/favorites" },
		{ id: "trash", label: t("driveTrash"), icon: Trash2Icon, to: "/trash" },
		{ id: "sharedIn", label: t("common:driveSharedIn"), icon: UsersIcon },
		{ id: "sharedOut", label: t("common:driveSharedOut"), icon: Share2Icon },
		{ id: "links", label: t("common:driveLinks"), icon: Link2Icon }
	]

	return (
		<aside className="hidden h-svh w-60 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
			<div className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
				<NavItem
					icon={FolderClosedIcon}
					label={t("driveMyDrive")}
					to="/drive"
				/>
				<Separator className="my-2" />
				<div className="flex flex-col gap-0.5">
					{items.map(({ id, label, icon, to }) => (
						<NavItem
							key={id}
							icon={icon}
							label={label}
							to={to}
						/>
					))}
				</div>
			</div>
		</aside>
	)
}
