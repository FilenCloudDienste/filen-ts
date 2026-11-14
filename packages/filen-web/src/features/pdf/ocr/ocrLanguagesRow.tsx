import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { SettingsRow } from "@/features/settings/components/settingsLayout"
import { OcrLanguagePicker } from "@/features/pdf/ocr/ocrLanguagePicker"
import { ocrLanguageName } from "@/features/pdf/ocr/ocrLanguageNames"
import { pickedOcrLanguages, setOcrLanguages, useOcrLanguagePreference } from "@/features/pdf/ocr/ocrLanguagePreference"
import type { OcrLanguage } from "@/features/pdf/ocr/languages"

interface LanguagesDialogProps {
	initial: readonly OcrLanguage[]
	onClose: () => void
}

function LanguagesDialog({ initial, onClose }: LanguagesDialogProps) {
	const { t } = useTranslation(["preview", "common"])
	const [languages, setLanguages] = useState<readonly OcrLanguage[]>(initial)

	return (
		<Dialog
			open
			onOpenChange={next => {
				if (!next) onClose()
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("previewPdfOcrSettingsTitle")}</DialogTitle>
					<DialogDescription>{t("previewPdfOcrSettingsDialogDescription")}</DialogDescription>
				</DialogHeader>
				<OcrLanguagePicker
					languages={languages}
					disabled={false}
					onChange={setLanguages}
				/>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={onClose}
					>
						{t("common:cancel")}
					</Button>
					<Button
						type="button"
						disabled={languages.length === 0}
						onClick={() => {
							setOcrLanguages(languages)
							onClose()
						}}
					>
						{t("previewPdfOcrSettingsSave")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

// Settings › Office: the text recognition languages on this device (the Recognise text dialog starts with them).
export function OcrLanguagesRow() {
	const { t, i18n } = useTranslation("preview")
	const preference = useOcrLanguagePreference()
	const languages = pickedOcrLanguages(preference, i18n.language)
	const [editing, setEditing] = useState(false)

	return (
		<SettingsRow
			label={t("previewPdfOcrSettingsTitle")}
			description={t("previewPdfOcrSettingsDescription")}
		>
			<div className="flex min-w-0 items-center gap-3">
				<span className="truncate text-sm text-muted-foreground">
					{languages.map(language => ocrLanguageName(language, i18n.language)).join(", ")}
				</span>
				<Button
					type="button"
					variant="outline"
					aria-label={t("previewPdfOcrSettingsTitle")}
					onClick={() => {
						setEditing(true)
					}}
				>
					{t("previewPdfOcrSettingsChange")}
				</Button>
			</div>
			{editing ? (
				<LanguagesDialog
					initial={languages}
					onClose={() => {
						setEditing(false)
					}}
				/>
			) : null}
		</SettingsRow>
	)
}
