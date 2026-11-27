import type { ComponentType } from "react"
import type { AppHelpEntry } from "@filen/shared/assistant"
import {
	UserIcon,
	ShieldIcon,
	SunMoonIcon,
	KeyboardIcon,
	HistoryIcon,
	CreditCardIcon,
	SlidersHorizontalIcon,
	MonitorIcon,
	GemIcon,
	FilePenLineIcon,
	HeadphonesIcon,
	SparklesIcon
} from "lucide-react"
import { desktopBridge } from "@/lib/desktop"

// The Settings sections in sidebar order, for the settings sidebar and the command palette.

type IconType = ComponentType<{ className?: string }>

export type SettingsRoute =
	| "/settings/account"
	| "/settings/security"
	| "/settings/appearance"
	| "/settings/keyboard"
	| "/settings/office"
	| "/settings/audio"
	| "/settings/assistant"
	| "/settings/events"
	| "/settings/plans"
	| "/settings/billing"
	| "/settings/advanced"
	| "/settings/desktop"

export interface SettingsSidebarItem {
	id: string
	labelKey:
		| "settingsSectionAccount"
		| "settingsSectionSecurity"
		| "settingsSectionAppearance"
		| "settingsSectionKeyboard"
		| "settingsSectionOffice"
		| "settingsSectionAudio"
		| "settingsSectionAssistant"
		| "settingsSectionEvents"
		| "settingsSectionPlans"
		| "settingsSectionBilling"
		| "settingsSectionAdvanced"
		| "settingsSectionDesktop"
	icon: IconType
	to: SettingsRoute
}

// Account first (the index redirect's landing section — see routes/_app/settings/index.tsx),
// Security second (the already-shipped page, unchanged), then Appearance/Keyboard/Office/Audio/Assistant/Events/Plans (web only)/
// Billing/Advanced, and Desktop in the desktop app only.
export const SETTINGS_ITEMS: SettingsSidebarItem[] = [
	{ id: "account", labelKey: "settingsSectionAccount", icon: UserIcon, to: "/settings/account" },
	{ id: "security", labelKey: "settingsSectionSecurity", icon: ShieldIcon, to: "/settings/security" },
	{ id: "appearance", labelKey: "settingsSectionAppearance", icon: SunMoonIcon, to: "/settings/appearance" },
	{ id: "keyboard", labelKey: "settingsSectionKeyboard", icon: KeyboardIcon, to: "/settings/keyboard" },
	{ id: "office", labelKey: "settingsSectionOffice", icon: FilePenLineIcon, to: "/settings/office" },
	{ id: "audio", labelKey: "settingsSectionAudio", icon: HeadphonesIcon, to: "/settings/audio" },
	{ id: "assistant", labelKey: "settingsSectionAssistant", icon: SparklesIcon, to: "/settings/assistant" },
	{ id: "events", labelKey: "settingsSectionEvents", icon: HistoryIcon, to: "/settings/events" },
	// Plans and checkout exist only in the web app.
	...(desktopBridge() === undefined
		? [{ id: "plans", labelKey: "settingsSectionPlans", icon: GemIcon, to: "/settings/plans" } as const]
		: []),
	{ id: "billing", labelKey: "settingsSectionBilling", icon: CreditCardIcon, to: "/settings/billing" },
	{ id: "advanced", labelKey: "settingsSectionAdvanced", icon: SlidersHorizontalIcon, to: "/settings/advanced" },
	...(desktopBridge() === undefined
		? []
		: [{ id: "desktop", labelKey: "settingsSectionDesktop", icon: MonitorIcon, to: "/settings/desktop" } as const])
]

// The section showing a setting the settings search found.
export function settingsSectionOf(entry: AppHelpEntry): SettingsSidebarItem | undefined {
	return SETTINGS_ITEMS.find(item => item.id === entry.section)
}
