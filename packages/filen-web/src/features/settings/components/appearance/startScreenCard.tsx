import { useTranslation } from "react-i18next"
import { useStartScreenQuery } from "@/features/shell/queries/startScreen"
import { setStartScreen, START_SCREENS, type StartScreen } from "@/features/shell/lib/startScreen"
import type { SettingsKey } from "@/lib/i18n"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Field, FieldContent, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const START_SCREEN_LABEL_KEYS: Record<StartScreen, SettingsKey> = {
	drive: "settingsStartScreenDrive",
	notes: "settingsStartScreenNotes",
	chats: "settingsStartScreenChats",
	contacts: "settingsStartScreenContacts"
}

// Which top-level module the app redirects to once boot resolves an authed session
// (routes/index.tsx, via rootRedirect.ts). Just the preference + its effect — no full picker screen,
// mirroring mobile's Appearance → Start screen row but as a plain inline select like this page's own
// ThemeCard.
function StartScreenCard() {
	const { t } = useTranslation("settings")
	const query = useStartScreenQuery()

	async function apply(next: StartScreen): Promise<void> {
		await setStartScreen(next)
		void query.refetch()
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsStartScreenTitle")}</CardTitle>
				<CardDescription>{t("settingsStartScreenDescription")}</CardDescription>
			</CardHeader>
			<CardContent>
				<Field orientation="horizontal">
					<FieldContent>
						<FieldLabel htmlFor="start-screen-select">{t("settingsStartScreenTitle")}</FieldLabel>
					</FieldContent>
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
						<SelectTrigger id="start-screen-select">
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
				</Field>
			</CardContent>
		</Card>
	)
}

export { StartScreenCard }
