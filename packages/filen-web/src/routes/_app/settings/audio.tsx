import { useEffect } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { HeadphonesIcon } from "lucide-react"
import { hydrateSmoothTransitionsPrefs } from "@/features/audio/store/useSmoothTransitionsStore"
import { SmoothTransitionsRows } from "@/features/settings/components/audio/smoothTransitionsRows"
import { SettingsGroup, SettingsPage } from "@/features/settings/components/settingsLayout"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

export const Route = createFileRoute("/_app/settings/audio")({
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionAudio"), i18n.t("common:settings")] }),
	component: AudioSettingsPage
})

// The audio player's settings, kept on this device.
function AudioSettingsPage() {
	const { t } = useTranslation(["settings", "audio"])

	useEffect(() => {
		void hydrateSmoothTransitionsPrefs()
	}, [])

	return (
		<SettingsPage
			icon={HeadphonesIcon}
			title={t("settingsSectionAudio")}
		>
			<SettingsGroup title={t("audio:smoothTransitions")}>
				<SmoothTransitionsRows />
			</SettingsGroup>
		</SettingsPage>
	)
}
