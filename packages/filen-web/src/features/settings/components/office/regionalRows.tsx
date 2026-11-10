import { useTranslation } from "react-i18next"
import type { OfficePaperSize } from "@filen/shared"
import { useOfficeSettings } from "@/features/office/lib/officeSettings"
import { useRegionalLanguage } from "@/features/office/lib/regionalFormat"
import { SettingsSelectRow } from "@/features/settings/components/settingRows"
import { saveSyncedOfficeSetting } from "@/features/settings/components/office/syncedSetting"
import { BROWSER_LANGUAGE, languageName } from "@/features/settings/components/office/languageNames"
import { useIsOnline } from "@/lib/useIsOnline"

// The regional formats offered: each a language with its region, as the spreadsheet's number and date entry reads
// them (formulaBar/sheetLocale.ts).
const REGIONAL_FORMATS: readonly string[] = [
	"en-US",
	"en-GB",
	"en-CA",
	"en-AU",
	"en-IN",
	"de-DE",
	"de-AT",
	"de-CH",
	"fr-FR",
	"fr-BE",
	"fr-CA",
	"fr-CH",
	"es-ES",
	"es-MX",
	"es-AR",
	"it-IT",
	"it-CH",
	"pt-BR",
	"pt-PT",
	"nl-NL",
	"nl-BE",
	"pl-PL",
	"cs-CZ",
	"da-DK",
	"fi-FI",
	"nb-NO",
	"sv-SE",
	"hu-HU",
	"ro-RO",
	"ru-RU",
	"uk-UA",
	"tr-TR",
	"hi-IN",
	"bn-BD",
	"id-ID",
	"th-TH",
	"vi-VN",
	"ja-JP",
	"ko-KR",
	"zh-CN",
	"zh-TW"
]

type PaperChoice = OfficePaperSize | "auto"

// A number and a date as `tag` writes them, for the row's description.
function formatExample(tag: string): string {
	try {
		return `${new Intl.NumberFormat(tag).format(1234.5)}, ${new Intl.DateTimeFormat(tag, { dateStyle: "short" }).format(new Date(2000, 10, 22))}`
	} catch {
		return "1,234.5, 11/22/00"
	}
}

// Office → Regional: the spreadsheet regional format (numbers, dates, separators) and the paper of new files. Synced.
export function OfficeRegionalRows() {
	const { t, i18n } = useTranslation(["settings", "common"])
	const settings = useOfficeSettings()
	const online = useIsOnline()
	const disabled = !settings.loaded || !online
	const regional = useRegionalLanguage()

	return (
		<>
			<SettingsSelectRow
				label={t("settingsOfficeRegionalFormat")}
				description={t("settingsOfficeRegionalFormatDescription", { example: formatExample(regional) })}
				id="office-regional-format"
				options={[
					{ value: BROWSER_LANGUAGE, label: t("settingsOfficeBrowserLanguage") },
					...REGIONAL_FORMATS.map(tag => ({ value: tag, label: languageName(tag, i18n.language) }))
				]}
				value={settings.regionalFormat ?? BROWSER_LANGUAGE}
				disabled={disabled}
				onChange={value => {
					saveSyncedOfficeSetting("regionalFormat", value === BROWSER_LANGUAGE ? null : value)
				}}
			/>
			<SettingsSelectRow<PaperChoice>
				label={t("settingsOfficePaperSize")}
				description={t("settingsOfficePaperSizeDescription")}
				id="office-paper-size"
				options={[
					{ value: "auto", label: t("settingsOfficePaperAutomatic") },
					{ value: "a4", label: t("settingsOfficePaperA4") },
					{ value: "letter", label: t("settingsOfficePaperLetter") }
				]}
				value={settings.paperSize ?? "auto"}
				disabled={disabled}
				onChange={value => {
					saveSyncedOfficeSetting("paperSize", value === "auto" ? null : value)
				}}
			/>
		</>
	)
}
