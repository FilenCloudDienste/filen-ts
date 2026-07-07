import type { ComponentType } from "react"
import { useTranslation } from "react-i18next"
import { FolderClosedIcon, ClockIcon, StarIcon, Trash2Icon, UsersIcon, Share2Icon, Link2Icon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Separator } from "@/components/ui/separator"

type IconType = ComponentType<{ className?: string }>

function NavItem({ icon: Icon, label, active }: { icon: IconType; label: string; active?: boolean }) {
	return (
		<button
			type="button"
			aria-current={active ? "page" : undefined}
			className={cn(
				"flex h-8 w-full items-center gap-2.5 rounded-xl px-2.5 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30 [&_svg]:size-4 [&_svg]:shrink-0",
				active
					? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
					: "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
			)}
		>
			<Icon className={active ? "text-primary" : "text-muted-foreground"} />
			<span className="truncate">{label}</span>
		</button>
	)
}

export function DriveSidebar() {
	const { t } = useTranslation(["drive", "common"])

	// Renders the Drive information architecture as inert rows: the destinations (Recents,
	// Favorites, Trash, sharing, links) are wired up later. No fabricated directory tree or counts —
	// only the real, stable IA labels, so the sidebar reads as intentional rather than seeded with
	// placeholder data. Built inside the component rather than as a module-level constant: its
	// labels span two namespaces (the drive listing surface, plus the sharing/link destinations
	// still in common until their own listing surface ships), so each needs its own resolved `t()`
	// call rather than a single deferred key lookup.
	const items: { id: string; label: string; icon: IconType }[] = [
		{ id: "recents", label: t("driveRecents"), icon: ClockIcon },
		{ id: "favorites", label: t("driveFavorites"), icon: StarIcon },
		{ id: "trash", label: t("driveTrash"), icon: Trash2Icon },
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
					active
				/>
				<Separator className="my-2" />
				<div className="flex flex-col gap-0.5">
					{items.map(({ id, label, icon }) => (
						<NavItem
							key={id}
							icon={icon}
							label={label}
						/>
					))}
				</div>
			</div>
		</aside>
	)
}
