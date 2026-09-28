import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { KeyboardIcon } from "lucide-react"
import { ShortcutsList } from "@/lib/keymap/shortcutsList"
import { SettingsBlock, SettingsGroup, SettingsPage } from "@/features/settings/components/settingsLayout"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

export const Route = createFileRoute("/_app/settings/keyboard")({
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionKeyboard"), i18n.t("common:settings")] }),
	component: KeyboardPage
})

// The settings half of the shortcuts surface. Same <ShortcutsList /> the ? overlay renders — this page
// is only the settings shell around it, never a second list or a second data path.
function KeyboardPage() {
	const { t } = useTranslation(["settings", "common"])

	return (
		<SettingsPage
			icon={KeyboardIcon}
			title={t("settingsSectionKeyboard")}
		>
			<SettingsGroup description={t("common:shortcutsDescription")}>
				<SettingsBlock>
					<ShortcutsList />
				</SettingsBlock>
			</SettingsGroup>
		</SettingsPage>
	)
}
