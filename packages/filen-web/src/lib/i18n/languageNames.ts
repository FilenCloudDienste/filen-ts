// One `Intl.DisplayNames` per UI language, shared by every list that names languages; null where the platform has none.
const formatters = new Map<string, Intl.DisplayNames | null>()

export function languageDisplayNames(uiLanguage: string): Intl.DisplayNames | null {
	let names = formatters.get(uiLanguage)

	if (names === undefined) {
		try {
			names = new Intl.DisplayNames([uiLanguage], { type: "language" })
		} catch {
			names = null
		}

		formatters.set(uiLanguage, names)
	}

	return names
}

// A language tag's name in the UI language ("German (Switzerland)" for de-CH in English); the tag itself where the
// platform names none.
export function languageName(tag: string, uiLanguage: string): string {
	try {
		return languageDisplayNames(uiLanguage)?.of(tag) ?? tag
	} catch {
		return tag
	}
}
