import { useTranslation } from "react-i18next"
import { PlusIcon, XIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { OCR_LANGUAGES, type OcrLanguage } from "@/features/pdf/ocr/languages"
import { ocrLanguageName } from "@/features/pdf/ocr/ocrLanguageNames"

export interface OcrLanguagePickerProps {
	languages: readonly OcrLanguage[]
	disabled: boolean
	onChange: (languages: OcrLanguage[]) => void
}

// The recognition languages as chips (the last one cannot be removed) and an Add language menu of the others, by
// name in the UI language.
export function OcrLanguagePicker({ languages, disabled, onChange }: OcrLanguagePickerProps) {
	const { t, i18n } = useTranslation("preview")
	const others = OCR_LANGUAGES.filter(language => !languages.includes(language))
		.map(language => ({ language, name: ocrLanguageName(language, i18n.language) }))
		.sort((a, b) => a.name.localeCompare(b.name, i18n.language))

	return (
		<div className="flex flex-wrap items-center gap-2">
			{languages.map(language => {
				const name = ocrLanguageName(language, i18n.language)

				return (
					<Badge
						key={language}
						variant="secondary"
						className="h-7 gap-1 pr-1 text-sm"
					>
						{name}
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							disabled={disabled || languages.length === 1}
							aria-label={t("previewPdfOcrRemoveLanguage", { language: name })}
							onClick={() => {
								onChange(languages.filter(other => other !== language))
							}}
						>
							<XIcon />
						</Button>
					</Badge>
				)
			})}
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={disabled || others.length === 0}
						>
							<PlusIcon data-icon="inline-start" />
							{t("previewPdfOcrAddLanguage")}
						</Button>
					}
				/>
				<DropdownMenuContent
					align="start"
					className="max-h-72"
				>
					<DropdownMenuGroup>
						{others.map(({ language, name }) => (
							<DropdownMenuItem
								key={language}
								onClick={() => {
									onChange([...languages, language])
								}}
							>
								{name}
							</DropdownMenuItem>
						))}
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	)
}
