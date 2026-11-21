import { useTranslation } from "react-i18next"
import { DOCX_MARKUP_MODES, type DocxMarkupMode } from "@filen/office/dom/docx"
import { setOfficeViewSettings, useOfficeViewSettings, type DocxOpenView } from "@/features/office/lib/officeViewSettings"
import { setDocxFormattingMarks, useDocxFormattingMarks } from "@/features/preview/lib/docxFormattingMarks"
import { setRibbonCollapsed, useRibbonCollapsed } from "@/features/office/lib/ribbonSettings"
import { MARKUP_LABELS } from "@/features/preview/components/docxViewer.logic"
import { PreferenceToggleRow, SettingsSelectRow } from "@/features/settings/components/settingRows"

// Office → Word documents: how a document opens on this device (its markup, pages or Mobile view, formatting marks)
// and the AutoFormat As You Type it is edited with (smart quotes, automatic lists).
export function OfficeWordRows() {
	const { t } = useTranslation(["settings", "preview"])
	const view = useOfficeViewSettings()
	const formattingMarks = useDocxFormattingMarks()

	return (
		<>
			<SettingsSelectRow<DocxMarkupMode>
				label={t("settingsOfficeMarkupView")}
				helpId="markupView"
				description={t("settingsOfficeMarkupViewDescription")}
				id="office-markup-view"
				options={DOCX_MARKUP_MODES.map(info => ({ value: info.mode, label: t(`preview:${MARKUP_LABELS[info.mode]}`) }))}
				value={view.markup}
				disabled={false}
				onChange={markup => {
					setOfficeViewSettings({ markup })
				}}
			/>
			<SettingsSelectRow<DocxOpenView>
				label={t("settingsOfficeOpenIn")}
				helpId="openIn"
				description={t("settingsOfficeOpenInDescription")}
				id="office-open-in"
				options={[
					{ value: "auto", label: t("settingsOfficeOpenInAutomatic") },
					{ value: "pages", label: t("settingsOfficeOpenInPages") },
					{ value: "reflow", label: t("preview:previewDocxMobileView") }
				]}
				value={view.docxView}
				disabled={false}
				onChange={docxView => {
					setOfficeViewSettings({ docxView })
				}}
			/>
			<PreferenceToggleRow
				title={t("settingsOfficeFormattingMarks")}
				helpId="formattingMarks"
				description={t("settingsOfficeFormattingMarksDescription")}
				checked={formattingMarks}
				disabled={false}
				onCheckedChange={setDocxFormattingMarks}
			/>
			<PreferenceToggleRow
				title={t("settingsOfficeAutoQuotes")}
				helpId="autoQuotes"
				description={t("settingsOfficeAutoQuotesDescription")}
				checked={view.autoQuotes ?? true}
				disabled={false}
				onCheckedChange={autoQuotes => {
					setOfficeViewSettings({ autoQuotes })
				}}
			/>
			<PreferenceToggleRow
				title={t("settingsOfficeAutoLists")}
				helpId="autoLists"
				description={t("settingsOfficeAutoListsDescription")}
				checked={view.autoLists ?? true}
				disabled={false}
				onCheckedChange={autoLists => {
					setOfficeViewSettings({ autoLists })
				}}
			/>
		</>
	)
}

// Office → Editor layout: the ribbon in every editor, and the panes a presentation opens with, on this device.
export function OfficeLayoutRows() {
	const { t } = useTranslation("settings")
	const view = useOfficeViewSettings()
	const ribbonCollapsed = useRibbonCollapsed()

	return (
		<>
			<PreferenceToggleRow
				title={t("settingsOfficeRibbonTabsOnly")}
				helpId="ribbonTabsOnly"
				description={t("settingsOfficeRibbonTabsOnlyDescription")}
				checked={ribbonCollapsed}
				disabled={false}
				onCheckedChange={setRibbonCollapsed}
			/>
			<PreferenceToggleRow
				title={t("settingsOfficeSlideRail")}
				helpId="slideRail"
				description={t("settingsOfficeSlideRailDescription")}
				checked={view.slideRail}
				disabled={false}
				onCheckedChange={slideRail => {
					setOfficeViewSettings({ slideRail })
				}}
			/>
			<PreferenceToggleRow
				title={t("settingsOfficeNotesPane")}
				helpId="notesPane"
				description={t("settingsOfficeNotesPaneDescription")}
				checked={view.notesPane}
				disabled={false}
				onCheckedChange={notesPane => {
					setOfficeViewSettings({ notesPane })
				}}
			/>
		</>
	)
}
