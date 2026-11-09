import { languageTag } from "../forms/dates"

// A w:lang value as the well-formed BCP 47 tag (RFC 5646) /Lang must be (ISO 32000-1 §14.9.2, ISO 14289-1 §7.2):
// a Windows language identifier (ST_Lang's hex form) through its table, Word's sort-order suffix ("es-ES_tradnl")
// cut, an underscore read as the separator ("en_US"); undefined for anything else, so the next candidate is taken.
export function pdfLanguage(value: string | undefined): string | undefined {
	if (value === undefined || value.length === 0) return undefined

	const tag = languageTag(value)

	if (tag === undefined) return undefined

	const sorted = /^([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})+)_[A-Za-z]+$/.exec(tag)

	try {
		return Intl.getCanonicalLocales((sorted?.[1] ?? tag).replaceAll("_", "-"))[0]
	} catch {
		return undefined
	}
}

function primary(tag: string): string {
	const dash = tag.indexOf("-")

	return (dash < 0 ? tag : tag.slice(0, dash)).toLowerCase()
}

// The /Lang each style's text is marked with (ISO 14289-1 §7.2): its language where its primary subtag differs
// from the document's (a region alone, as en-US in an en-GB document, is no change of language).
export function styleLanguages(languages: readonly (string | undefined)[], documentLang: string | undefined): (string | undefined)[] {
	const base = documentLang === undefined ? undefined : primary(documentLang)
	const known = new Map<string, string | undefined>()

	return languages.map(language => {
		if (language === undefined) return undefined

		let lang = known.get(language)

		if (!known.has(language)) {
			const tag = pdfLanguage(language)

			lang = tag !== undefined && primary(tag) !== base ? tag : undefined
			known.set(language, lang)
		}

		return lang
	})
}
