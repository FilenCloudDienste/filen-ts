import { useState } from "react"
import { useTranslation } from "react-i18next"
import { DICTIONARY_IDS } from "@filen/spellcheck"
import type { OfficeSettingKey } from "@filen/shared"
import { useOfficeSettings } from "@/features/office/lib/officeSettings"
import { PreferenceToggleRow, SettingsSelectRow } from "@/features/settings/components/settingRows"
import { SettingsRow } from "@/features/settings/components/settingsLayout"
import { saveSyncedOfficeSetting } from "@/features/settings/components/office/syncedSetting"
import { DictionaryDialog } from "@/features/settings/components/office/dictionaryDialog"
import { BROWSER_LANGUAGE, languageName } from "@/features/settings/components/office/languageNames"
import type { SettingsKey } from "@/lib/i18n"
import { Button } from "@/components/ui/button"
import { useIsOnline } from "@/lib/useIsOnline"

// One per shipped dictionary (a bundled dictionary checks the text; nothing is downloaded for a language without one).
const PROOFING_LANGUAGES: readonly string[] = DICTIONARY_IDS.map(id => id.replace("_", "-"))

type ProofingOption = Extract<OfficeSettingKey, "ignoreUppercase" | "ignoreWordsWithNumbers" | "ignoreAddresses" | "flagRepeatedWords">

const PROOFING_OPTIONS: readonly { key: ProofingOption; title: SettingsKey; description: SettingsKey }[] = [
	{ key: "ignoreUppercase", title: "settingsOfficeIgnoreUppercase", description: "settingsOfficeIgnoreUppercaseDescription" },
	{ key: "ignoreWordsWithNumbers", title: "settingsOfficeIgnoreNumbers", description: "settingsOfficeIgnoreNumbersDescription" },
	{ key: "ignoreAddresses", title: "settingsOfficeIgnoreAddresses", description: "settingsOfficeIgnoreAddressesDescription" },
	{ key: "flagRepeatedWords", title: "settingsOfficeFlagRepeated", description: "settingsOfficeFlagRepeatedDescription" }
]

// Office → Proofing: Word's "Check spelling as you type", the language of text that names none, the proofing options
// and the user's dictionary. Synced; the options apply while spelling is on.
export function OfficeProofingRows() {
	const { t, i18n } = useTranslation(["settings", "common"])
	const settings = useOfficeSettings()
	const online = useIsOnline()
	const disabled = !settings.loaded || !online
	const offlineReason = online ? undefined : t("common:offlineActionDisabled")
	const [dictionaryOpen, setDictionaryOpen] = useState(false)

	return (
		<>
			<PreferenceToggleRow
				title={t("settingsOfficeSpellCheck")}
				description={t("settingsOfficeSpellCheckDescription")}
				checked={settings.spellCheck}
				disabled={disabled}
				disabledReason={offlineReason}
				onCheckedChange={checked => {
					saveSyncedOfficeSetting("spellCheck", checked)
				}}
			/>
			<SettingsSelectRow
				label={t("settingsOfficeProofingLanguage")}
				description={t("settingsOfficeProofingLanguageDescription")}
				id="office-proofing-language"
				options={[
					{ value: BROWSER_LANGUAGE, label: t("settingsOfficeBrowserLanguage") },
					...PROOFING_LANGUAGES.map(tag => ({ value: tag, label: languageName(tag, i18n.language) }))
				]}
				value={settings.proofingLanguage ?? BROWSER_LANGUAGE}
				disabled={disabled || !settings.spellCheck}
				onChange={value => {
					saveSyncedOfficeSetting("proofingLanguage", value === BROWSER_LANGUAGE ? null : value)
				}}
			/>
			{PROOFING_OPTIONS.map(option => (
				<PreferenceToggleRow
					key={option.key}
					title={t(option.title)}
					description={t(option.description)}
					checked={settings[option.key]}
					disabled={disabled || !settings.spellCheck}
					disabledReason={offlineReason}
					onCheckedChange={checked => {
						saveSyncedOfficeSetting(option.key, checked)
					}}
				/>
			))}
			<SettingsRow
				label={t("settingsOfficeDictionary")}
				description={t("settingsOfficeDictionaryDescription")}
			>
				<Button
					type="button"
					variant="outline"
					aria-label={t("settingsOfficeDictionary")}
					onClick={() => {
						setDictionaryOpen(true)
					}}
				>
					{t("settingsOfficeDictionaryManage")}
				</Button>
			</SettingsRow>
			<DictionaryDialog
				open={dictionaryOpen}
				online={online}
				onOpenChange={setDictionaryOpen}
			/>
		</>
	)
}
