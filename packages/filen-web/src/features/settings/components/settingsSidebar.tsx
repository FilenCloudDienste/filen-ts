import type { ComponentType } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { UserIcon, ShieldIcon, SunMoonIcon, KeyboardIcon, HistoryIcon, CreditCardIcon, SlidersHorizontalIcon } from "lucide-react"
import { SidebarPanel } from "@/features/shell/components/sidebarPanel"
import { SIDEBAR_NAV_ITEM_CLASS } from "@/features/shell/lib/sidebarNavItem"

type IconType = ComponentType<{ className?: string }>

type SettingsRoute =
	| "/settings/account"
	| "/settings/security"
	| "/settings/appearance"
	| "/settings/keyboard"
	| "/settings/events"
	| "/settings/billing"
	| "/settings/advanced"

interface SettingsSidebarItem {
	id: string
	labelKey:
		| "settingsSectionAccount"
		| "settingsSectionSecurity"
		| "settingsSectionAppearance"
		| "settingsSectionKeyboard"
		| "settingsSectionEvents"
		| "settingsSectionBilling"
		| "settingsSectionAdvanced"
	icon: IconType
	to: SettingsRoute
}

// Account first (the index redirect's landing section — see routes/_app/settings/index.tsx),
// Security second (the already-shipped page, unchanged), then Appearance/Keyboard/Events/Billing/
// Advanced.
const SETTINGS_ITEMS: SettingsSidebarItem[] = [
	{ id: "account", labelKey: "settingsSectionAccount", icon: UserIcon, to: "/settings/account" },
	{ id: "security", labelKey: "settingsSectionSecurity", icon: ShieldIcon, to: "/settings/security" },
	{ id: "appearance", labelKey: "settingsSectionAppearance", icon: SunMoonIcon, to: "/settings/appearance" },
	{ id: "keyboard", labelKey: "settingsSectionKeyboard", icon: KeyboardIcon, to: "/settings/keyboard" },
	{ id: "events", labelKey: "settingsSectionEvents", icon: HistoryIcon, to: "/settings/events" },
	{ id: "billing", labelKey: "settingsSectionBilling", icon: CreditCardIcon, to: "/settings/billing" },
	{ id: "advanced", labelKey: "settingsSectionAdvanced", icon: SlidersHorizontalIcon, to: "/settings/advanced" }
]

// The shell's settings contextual sidebar: a flat list of section nav links, same w-52
// rounded-xl borderless panel geometry as the other three module sidebars. TanStack stamps
// `data-status="active"` on the matching Link automatically — no manual pathname comparison needed
// (unlike DriveSidebar's splat routes, every settings route here takes no params).
export function SettingsSidebar() {
	const { t } = useTranslation(["settings", "common"])

	return (
		<SidebarPanel>
			<div className="flex flex-1 flex-col overflow-y-auto p-3">
				<h2 className="truncate px-2.5 pt-1 pb-2.5 text-[15px] font-semibold">{t("common:settings")}</h2>
				<div className="flex flex-col gap-0.5">
					{SETTINGS_ITEMS.map(item => (
						<Link
							key={item.id}
							to={item.to}
							className={SIDEBAR_NAV_ITEM_CLASS}
						>
							<item.icon className="text-muted-foreground group-data-[status=active]:text-primary" />
							<span className="truncate">{t(item.labelKey)}</span>
						</Link>
					))}
				</div>
			</div>
		</SidebarPanel>
	)
}
