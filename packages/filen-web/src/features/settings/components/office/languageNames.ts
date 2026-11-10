// The language selects' value for "Browser language" (no tag chosen).
export const BROWSER_LANGUAGE = "browser"

// A language tag's name in the UI language ("German (Switzerland)" for de-CH in English); the tag itself where the
// platform names none. One formatter per UI language.
const formatters = new Map<string, Intl.DisplayNames | null>()

export function languageName(tag: string, uiLanguage: string): string {
	let names = formatters.get(uiLanguage)

	if (names === undefined) {
		try {
			names = new Intl.DisplayNames([uiLanguage], { type: "language" })
		} catch {
			names = null
		}

		formatters.set(uiLanguage, names)
	}

	try {
		return names?.of(tag) ?? tag
	} catch {
		return tag
	}
}
