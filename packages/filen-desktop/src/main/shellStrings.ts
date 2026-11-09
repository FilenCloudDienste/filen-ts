import { type } from "arktype"
import {
	DESKTOP_SHELL_STRINGS,
	DESKTOP_SHELL_STRING_MAX_LENGTH,
	formatShellString,
	type DesktopShellStringKey
} from "@filen/shared/desktopShellStrings"
import { type AtomicFile, errorCode } from "./atomicFile.ts"

// The shell's own text in the UI language the page last reported. English (the shared catalog) until then, and for
// any key the page did not send. Kept in userData, so menu and tray come up translated before the page loads.

const PLURAL_SUFFIX = /_(?:zero|one|two|few|many|other)$/

const payloadSchema = type({
	language: "0 < string <= 35",
	strings: { "[string]": type.string.atMostLength(DESKTOP_SHELL_STRING_MAX_LENGTH) }
})

type Values = Readonly<Record<string, string | number>>

const PLURAL_BASES = new Set(
	Object.keys(DESKTOP_SHELL_STRINGS)
		.filter(key => PLURAL_SUFFIX.test(key))
		.map(key => key.replace(PLURAL_SUFFIX, ""))
)

function isKnownKey(key: string): boolean {
	return key in DESKTOP_SHELL_STRINGS || (PLURAL_SUFFIX.test(key) && PLURAL_BASES.has(key.replace(PLURAL_SUFFIX, "")))
}

let language = "en"
let strings = new Map<string, string>()
// Writes of the stored copy run one after another: they share the atomic file's sibling.
let writing: Promise<void> = Promise.resolve()

function english(key: string): string | undefined {
	return (DESKTOP_SHELL_STRINGS as Readonly<Record<string, string>>)[key]
}

/** The text of `key` in the current language, `{{name}}` placeholders filled from `values`. */
export function shellText(key: DesktopShellStringKey, values: Values = {}): string {
	return formatShellString(strings.get(key) ?? english(key) ?? key, values)
}

/** The form of a plural key (`base` without its suffix) the current language selects for `count`. */
export function shellPlural(base: string, count: number, values: Values = {}): string {
	const category = new Intl.PluralRules(language).select(count)
	const template =
		strings.get(`${base}_${category}`) ?? strings.get(`${base}_other`) ?? english(`${base}_${category}`) ?? english(`${base}_other`)

	return formatShellString(template ?? base, { count, ...values })
}

/** The UI language main currently shows. */
export function shellLanguage(): string {
	return language
}

// Only known keys with non-empty text; null when the payload is malformed.
function parsePayload(payload: unknown): { language: string; strings: Map<string, string> } | null {
	const parsed = payloadSchema(payload)

	if (parsed instanceof type.errors) {
		return null
	}

	let supported: string

	try {
		supported = Intl.getCanonicalLocales(parsed.language)[0] ?? "en"
	} catch {
		return null
	}

	return {
		language: supported,
		strings: new Map(Object.entries(parsed.strings).filter(([key, text]) => text.length > 0 && isKnownKey(key)))
	}
}

function sameStrings(next: ReadonlyMap<string, string>): boolean {
	return next.size === strings.size && [...next].every(([key, text]) => strings.get(key) === text)
}

/**
 * Adopts the page's text. Returns whether anything changed (the caller relabels menu and tray), and stores it.
 * A malformed payload is ignored.
 */
export function applyShellStrings(payload: unknown, file: AtomicFile, warn: (message: string) => void): boolean {
	const next = parsePayload(payload)

	if (next === null || (next.language === language && sameStrings(next.strings))) {
		return false
	}

	language = next.language
	strings = next.strings

	const data = Buffer.from(JSON.stringify({ language, strings: Object.fromEntries(strings) }))

	writing = writing
		.then(() => file.write(data))
		.catch((error: unknown) => {
			warn(`shell strings not stored: ${errorCode(error)}`)
		})

	return true
}

/** Reads what the page last sent; English when there is nothing (or nothing readable). */
export async function loadShellStrings(file: AtomicFile, warn: (message: string) => void): Promise<void> {
	try {
		const raw = await file.read()
		const stored = raw === null ? null : parsePayload(JSON.parse(raw.toString("utf8")))

		if (stored !== null) {
			language = stored.language
			strings = stored.strings
		}
	} catch (error) {
		warn(`shell strings not read: ${errorCode(error)}`)
	}
}
