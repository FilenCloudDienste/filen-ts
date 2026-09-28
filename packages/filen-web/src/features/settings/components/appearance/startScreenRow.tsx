import { useTranslation } from "react-i18next"
import { useStartScreenQuery } from "@/features/shell/queries/startScreen"
import { setStartScreen, START_SCREENS, type StartScreen } from "@/features/shell/lib/startScreen"
import type { SettingsKey } from "@/lib/i18n"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

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
		<SettingsRow
			label={t("settingsStartScreenTitle")}
			description={t("settingsStartScreenDescription")}
			htmlFor="start-screen-select"
		>
			<Select
				items={START_SCREENS.map(screen => ({ value: screen, label: t(START_SCREEN_LABEL_KEYS[screen]) }))}
				value={query.data ?? "drive"}
				disabled={query.data === undefined}
				onValueChange={value => {
					if (value !== null) {
						void apply(value)
					}
				}}
			>
				<SelectTrigger
					id="start-screen-select"
					className="min-w-36"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectGroup>
						{START_SCREENS.map(screen => (
							<SelectItem
								key={screen}
								value={screen}
							>
								{t(START_SCREEN_LABEL_KEYS[screen])}
							</SelectItem>
						))}
					</SelectGroup>
				</SelectContent>
			</Select>
		</SettingsRow>
	)
}

export { StartScreenRow }
