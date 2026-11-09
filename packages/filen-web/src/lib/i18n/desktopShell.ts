import { DESKTOP_SHELL_STRING_KEYS } from "@filen/shared/desktopShellStrings"
import { desktopBridge } from "@/lib/desktop"
import { i18n } from "@/lib/i18n"

const PLURAL_KEY = /^(.+)_(?:zero|one|two|few|many|other)$/

// The desktop shell's own text (menu, tray, main's notifications and dialogs) in `language`, as raw templates:
// main fills the `{{…}}` placeholders and picks the plural form itself, so a plural key is sent in every form the
// language selects. A key missing in the language falls back along i18next's chain to English.
export function shellStringsFor(language: string): Record<string, string> {
	// i18next's own order: the language, its base (zh-TW → zh), English.
	const chain = new Set([language, language.split("-")[0] ?? language, "en"])
	const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories
	const strings: Record<string, string> = {}
	const resolve = (key: string): string | undefined => {
		for (const code of chain) {
			const value: unknown = i18n.getResource(code, "settings", key)

			if (typeof value === "string") {
				return value
			}
		}

		return undefined
	}

	for (const key of DESKTOP_SHELL_STRING_KEYS) {
		const base = PLURAL_KEY.exec(key)?.[1]
		const forms: [string, string][] =
			base === undefined ? [[key, key]] : categories.map(category => [`${base}_${category}`, `${base}_other`])

		for (const [form, fallback] of forms) {
			const value = resolve(form) ?? resolve(fallback)

			if (value !== undefined) {
				strings[form] = value
			}
		}
	}

	return strings
}

let subscribed = false

/** Sends main the shell text now and on every language change; a no-op outside the desktop app. */
export function syncDesktopShellStrings(): void {
	const app = desktopBridge()?.app

	if (subscribed || app === undefined) {
		return
	}

	subscribed = true

	const push = (language: string) => {
		app.setShellStrings({ language, strings: shellStringsFor(language) })
	}

	i18n.on("languageChanged", push)
	push(i18n.language)
}
