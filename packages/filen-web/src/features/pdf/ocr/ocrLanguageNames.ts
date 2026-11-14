import { languageName } from "@/features/settings/components/office/languageNames"
import { OCR_LANGUAGE_TAGS, type OcrLanguage } from "@/features/pdf/ocr/languages"

// A recognition language's name in the UI language ("German" for deu in English).
export function ocrLanguageName(language: OcrLanguage, uiLanguage: string): string {
	return languageName(OCR_LANGUAGE_TAGS[language], uiLanguage)
}
