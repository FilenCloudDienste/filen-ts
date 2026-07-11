import type { ComponentType } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { UserIcon, ShieldIcon, SunMoonIcon, HistoryIcon, CreditCardIcon } from "lucide-react"
import { cn } from "@/lib/utils"

type IconType = ComponentType<{ className?: string }>

type SettingsRoute = "/settings/account" | "/settings/security" | "/settings/appearance" | "/settings/events" | "/settings/billing"

interface SettingsSidebarItem {
	id: string
	labelKey:
		| "settingsSectionAccount"
		| "settingsSectionSecurity"
		| "settingsSectionAppearance"
		| "settingsSectionEvents"
		| "settingsSectionBilling"
	icon: IconType
	to: SettingsRoute
}

// Account first (the index redirect's landing section — see routes/_app/settings/index.tsx),
// Security second (the already-shipped page, unchanged), then Appearance/Events/Billing per D3.
const SETTINGS_ITEMS: SettingsSidebarItem[] = [
	{ id: "account", labelKey: "settingsSectionAccount", icon: UserIcon, to: "/settings/account" },
	{ id: "security", labelKey: "settingsSectionSecurity", icon: ShieldIcon, to: "/settings/security" },
	{ id: "appearance", labelKey: "settingsSectionAppearance", icon: SunMoonIcon, to: "/settings/appearance" },
	{ id: "events", labelKey: "settingsSectionEvents", icon: HistoryIcon, to: "/settings/events" },
	{ id: "billing", labelKey: "settingsSectionBilling", icon: CreditCardIcon, to: "/settings/billing" }
]

// Same row styling idiom as DriveSidebar/NotesSidebar/ChatsSidebar's own nav rows — each sidebar
// defines its own copy rather than sharing one (none of the three existing ones export theirs
// either), so this follows the established precedent rather than introducing a new shared module.
const NAV_ITEM_CLASS = cn(
	"group flex h-8 w-full items-center gap-2.5 rounded-xl px-2.5 text-sm transition-colors outline-none app-region-no-drag focus-visible:ring-3 focus-visible:ring-ring/30 [&_svg]:size-4 [&_svg]:shrink-0",
	"text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
	"data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium data-[status=active]:text-sidebar-accent-foreground"
)

// The shell's settings contextual sidebar (D3): a flat list of section nav links, same w-52
// rounded-xl borderless panel geometry as the other three module sidebars. TanStack stamps
// `data-status="active"` on the matching Link automatically — no manual pathname comparison needed
// (unlike DriveSidebar's splat routes, every settings route here takes no params).
export function SettingsSidebar() {
	const { t } = useTranslation(["settings", "common"])

	return (
		<aside
			// Drag region (Electron plumbing): inert in a plain browser, opted back out by every
			// interactive descendant via app-region-no-drag — same convention as the other sidebars.
			className="hidden w-52 shrink-0 flex-col rounded-xl bg-sidebar app-region-drag md:flex"
		>
			<div className="flex flex-1 flex-col overflow-y-auto p-3">
				<h2 className="truncate px-2.5 pt-1 pb-2.5 text-[15px] font-semibold">{t("common:settings")}</h2>
				<div className="flex flex-col gap-0.5">
					{SETTINGS_ITEMS.map(item => (
						<Link
							key={item.id}
							to={item.to}
							className={NAV_ITEM_CLASS}
						>
							<item.icon className="text-muted-foreground group-data-[status=active]:text-primary" />
							<span className="truncate">{t(item.labelKey)}</span>
						</Link>
					))}
				</div>
			</div>
		</aside>
	)
}
