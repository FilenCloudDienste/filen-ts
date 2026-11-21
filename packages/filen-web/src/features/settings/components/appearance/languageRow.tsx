import { useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { LANGUAGE_LABELS, type SupportedLanguage } from "@filen/shared/languages"
import { AVAILABLE_LANGUAGES, readStoredLanguage, setLanguagePreference, subscribeLanguagePreference } from "@/lib/i18n/language"
import { SettingsSelectRow } from "@/features/settings/components/settingRows"

type LanguageChoice = SupportedLanguage | "system"

function storedChoice(): LanguageChoice {
	return readStoredLanguage() ?? "system"
}

// English plus every language with a near-complete catalog, by native name; "Browser default" follows the browser's
// preferred languages. A pick applies at once, here and in this browser's other tabs.
function LanguageRow() {
	const { t } = useTranslation("settings")
	const choice = useSyncExternalStore(subscribeLanguagePreference, storedChoice)
	const options: { value: LanguageChoice; label: string }[] = [
		{ value: "system", label: t("settingsLanguageSystem") },
		...AVAILABLE_LANGUAGES.map(lang => ({ value: lang, label: LANGUAGE_LABELS[lang] }))
	]

	// The pick is stored either way; a catalog that cannot be fetched leaves the UI in English, so say so.
	async function pick(value: LanguageChoice): Promise<void> {
		if (!(await setLanguagePreference(value === "system" ? null : value))) {
			toast.error(t("settingsLanguageLoadFailed"))
		}
	}

	return (
		<SettingsSelectRow
			label={t("settingsLanguageTitle")}
			helpId="language"
			description={t("settingsLanguageDescription")}
			id="language-select"
			options={options}
			value={choice}
			disabled={false}
			onChange={value => void pick(value)}
		/>
	)
}

export { LanguageRow }
