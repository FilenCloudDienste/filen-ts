import { useTranslation } from "react-i18next"
import { useStartScreenQuery } from "@/features/shell/queries/startScreen"
import { DEFAULT_START_SCREEN, setStartScreen, START_SCREENS, type StartScreen } from "@/features/shell/lib/startScreen"
import type { SettingsKey } from "@/lib/i18n"
import { SettingsSelectRow } from "@/features/settings/components/settingRows"

const START_SCREEN_LABEL_KEYS: Record<StartScreen, SettingsKey> = {
	drive: "settingsStartScreenDrive",
	notes: "settingsStartScreenNotes",
	chats: "settingsStartScreenChats",
	contacts: "settingsStartScreenContacts"
}

// Which top-level module the app redirects to once boot resolves an authed session
// (routes/index.tsx, via rootRedirect.ts). Just the preference + its effect — no full picker screen,
// mirroring mobile's Appearance → Start screen row as a plain inline select like the Theme row.
function StartScreenRow() {
	const { t } = useTranslation("settings")
	const query = useStartScreenQuery()

	async function apply(next: StartScreen): Promise<void> {
		await setStartScreen(next)
		void query.refetch()
	}

	return (
		<SettingsSelectRow
			label={t("settingsStartScreenTitle")}
			description={t("settingsStartScreenDescription")}
			id="start-screen-select"
			options={START_SCREENS.map(screen => ({ value: screen, label: t(START_SCREEN_LABEL_KEYS[screen]) }))}
			value={query.data ?? DEFAULT_START_SCREEN}
			disabled={query.data === undefined}
			onChange={value => void apply(value)}
		/>
	)
}

export { StartScreenRow }
