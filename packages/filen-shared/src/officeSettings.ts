// The user's document-editing settings as stored (end-to-end encrypted, as a file the apps sync next to the
// user dictionary): the author comments and tracked changes carry, autosave, proofing and regional choices.
// Each setting is a last-writer-wins register, so devices that change it offline merge without one undoing
// the other unseen. An unset setting has no register (the author name: never asked yet).
//
// { "v": 1, "authorName": { "value": "<name>", "at": <stamp> }, "autosave": { "value": <boolean>, "at": <stamp> }, … }
//
// Every field besides "v" is a register. Registers this version does not know, and known ones whose value it cannot
// read, are kept as they are and written back, so a newer app's settings survive an older app's save. Stamps are
// milliseconds since the epoch; on a tie the larger value (in JSON text order) wins, so every device merges to the
// same document.

export const OFFICE_SETTINGS_FILE_NAME = "settings.v1.json"
export const OFFICE_SETTINGS_VERSION = 1
// Word's own limits for a user name and for the initials comments carry.
export const MAX_AUTHOR_NAME_LENGTH = 255
export const MAX_AUTHOR_INITIALS_LENGTH = 9
export const DEFAULT_OFFICE_AUTOSAVE = true
// The pauses after the last edit an autosave may wait for.
export const OFFICE_AUTOSAVE_DELAYS_MS = [15_000, 30_000, 60_000, 300_000] as const
export const DEFAULT_OFFICE_AUTOSAVE_DELAY_MS = 30_000

export type OfficeAutosaveDelay = (typeof OFFICE_AUTOSAVE_DELAYS_MS)[number]
export type OfficePaperSize = "a4" | "letter"

// Each setting as read. Null: not chosen (the author name: never given; the initials: from the name; the
// languages: the browser's; the paper: by region).
export interface OfficeSettingsValues {
	readonly authorName: string | null
	readonly authorInitials: string | null
	readonly autosave: boolean
	readonly autosaveDelayMs: OfficeAutosaveDelay
	// Word's "Check spelling as you type" and its proofing options.
	readonly spellCheck: boolean
	// BCP 47: the language of text that names none.
	readonly proofingLanguage: string | null
	readonly ignoreUppercase: boolean
	readonly ignoreWordsWithNumbers: boolean
	readonly ignoreAddresses: boolean
	readonly flagRepeatedWords: boolean
	// BCP 47: how numbers and dates are typed and shown in spreadsheets.
	readonly regionalFormat: string | null
	// The paper of new documents and workbooks.
	readonly paperSize: OfficePaperSize | null
}

export type OfficeSettingKey = keyof OfficeSettingsValues

export const OFFICE_SETTINGS_DEFAULTS: OfficeSettingsValues = {
	authorName: null,
	authorInitials: null,
	autosave: DEFAULT_OFFICE_AUTOSAVE,
	autosaveDelayMs: DEFAULT_OFFICE_AUTOSAVE_DELAY_MS,
	spellCheck: true,
	proofingLanguage: null,
	ignoreUppercase: true,
	ignoreWordsWithNumbers: true,
	ignoreAddresses: true,
	flagRepeatedWords: true,
	regionalFormat: null,
	paperSize: null
}

export interface OfficeSetting<T> {
	readonly value: T
	readonly at: number
}

export interface OfficeSettingsDoc {
	readonly v: typeof OFFICE_SETTINGS_VERSION
	// By field name, values as stored (read through officeSetting / officeSettingsValues).
	readonly registers: ReadonlyMap<string, OfficeSetting<unknown>>
}

// The file was written by a newer format: it must not be overwritten by this one.
export class OfficeSettingsVersionError extends Error {
	readonly version: unknown

	constructor(version: unknown) {
		super(`Unsupported office settings version ${String(version)}`)
		this.name = "OfficeSettingsVersionError"
		this.version = version
	}
}

export function emptyOfficeSettings(): OfficeSettingsDoc {
	return { v: OFFICE_SETTINGS_VERSION, registers: new Map() }
}

// The form an author name is stored in (NFC, inner whitespace collapsed, trimmed), or undefined when it is
// empty or too long.
export function normalizeAuthorName(name: string): string | undefined {
	const normalized = name.normalize("NFC").replace(/\s+/gu, " ").trim()

	// Control characters (other than the whitespace collapsed above) never belong in a name.
	if (normalized.length === 0 || normalized.length > MAX_AUTHOR_NAME_LENGTH || /\p{Cc}/u.test(normalized)) return undefined

	return normalized
}

// The form initials are stored in (NFC, no whitespace), or undefined when empty, too long or not text.
export function normalizeAuthorInitials(initials: string): string | undefined {
	const normalized = initials.normalize("NFC").replace(/\s+/gu, "")

	if (normalized.length === 0 || [...normalized].length > MAX_AUTHOR_INITIALS_LENGTH || /\p{Cc}/u.test(normalized)) return undefined

	return normalized
}

// A BCP 47 tag's shape (a language, then subtags), checked without asking the platform which tags it knows.
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,4}$/u

function readLanguage(raw: unknown): string | null | undefined {
	return raw === null ? null : typeof raw === "string" && raw.length <= 35 && LANGUAGE_TAG.test(raw) ? raw : undefined
}

function readBoolean(raw: unknown): boolean | undefined {
	return typeof raw === "boolean" ? raw : undefined
}

// A register's value when it is one this version reads; undefined otherwise (kept, and read as the default).
const READERS: { readonly [K in OfficeSettingKey]: (raw: unknown) => OfficeSettingsValues[K] | undefined } = {
	authorName: raw => (typeof raw === "string" ? normalizeAuthorName(raw) : undefined),
	authorInitials: raw => (raw === null ? null : typeof raw === "string" ? normalizeAuthorInitials(raw) : undefined),
	autosave: readBoolean,
	autosaveDelayMs: raw => OFFICE_AUTOSAVE_DELAYS_MS.find(delay => delay === raw),
	spellCheck: readBoolean,
	proofingLanguage: readLanguage,
	ignoreUppercase: readBoolean,
	ignoreWordsWithNumbers: readBoolean,
	ignoreAddresses: readBoolean,
	flagRepeatedWords: readBoolean,
	regionalFormat: readLanguage,
	paperSize: raw => (raw === null || raw === "a4" || raw === "letter" ? raw : undefined)
}

// Field order in the stored text: the known fields, then any others by name.
const KNOWN_KEYS = Object.keys(READERS) as readonly OfficeSettingKey[]
const KNOWN: ReadonlySet<string> = new Set(KNOWN_KEYS)
// A field name another version could write; anything else is not a setting.
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u

function clampStamp(stamp: number): number {
	return Math.min(Math.max(Math.trunc(stamp), -Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
}

function register(value: unknown): OfficeSetting<unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined

	const at: unknown = Reflect.get(value, "at")
	const held: unknown = Reflect.get(value, "value")

	if (held === undefined || typeof at !== "number" || !Number.isFinite(at)) return undefined

	return { value: held, at: clampStamp(at) }
}

// Reads a stored file; fields that are not registers are dropped. Throws OfficeSettingsVersionError for a newer
// format and SyntaxError for text that is not JSON.
export function parseOfficeSettings(text: string): OfficeSettingsDoc {
	const value: unknown = JSON.parse(text)

	if (typeof value !== "object" || value === null || Array.isArray(value)) return emptyOfficeSettings()

	const version: unknown = Reflect.get(value, "v")

	if (typeof version === "number" && version > OFFICE_SETTINGS_VERSION) throw new OfficeSettingsVersionError(version)

	const registers = new Map<string, OfficeSetting<unknown>>()

	for (const name of Object.keys(value)) {
		if (name === "v" || !FIELD_NAME.test(name)) continue

		const held = register(Reflect.get(value, name))

		if (held !== undefined) registers.set(name, held)
	}

	return { v: OFFICE_SETTINGS_VERSION, registers }
}

// Stable text (fixed field order), so equal documents serialise identically.
export function serializeOfficeSettings(doc: OfficeSettingsDoc): string {
	const others = [...doc.registers.keys()].filter(name => !KNOWN.has(name)).sort()
	const fields: [string, unknown][] = [["v", OFFICE_SETTINGS_VERSION]]

	for (const name of [...KNOWN_KEYS, ...others]) {
		const held = doc.registers.get(name)

		if (held !== undefined) fields.push([name, { value: held.value, at: held.at }])
	}

	return JSON.stringify(Object.fromEntries(fields))
}

function later<T>(a: OfficeSetting<T> | undefined, b: OfficeSetting<T> | undefined): OfficeSetting<T> | undefined {
	if (a === undefined) return b
	if (b === undefined || a.at > b.at) return a
	if (b.at > a.at) return b

	return JSON.stringify(a.value) >= JSON.stringify(b.value) ? a : b
}

export function mergeOfficeSettings(a: OfficeSettingsDoc, b: OfficeSettingsDoc): OfficeSettingsDoc {
	const registers = new Map<string, OfficeSetting<unknown>>()

	for (const name of new Set([...a.registers.keys(), ...b.registers.keys()])) {
		const winner = later(a.registers.get(name), b.registers.get(name))

		if (winner !== undefined) registers.set(name, winner)
	}

	return { v: OFFICE_SETTINGS_VERSION, registers }
}

// Whether two documents hold the same settings (an unchanged merge needs no upload).
export function sameOfficeSettings(a: OfficeSettingsDoc, b: OfficeSettingsDoc): boolean {
	return serializeOfficeSettings(a) === serializeOfficeSettings(b)
}

// A setting as read: its register's value when this version reads it, else the default.
export function officeSetting<K extends OfficeSettingKey>(doc: OfficeSettingsDoc, key: K): OfficeSettingsValues[K] {
	const held = doc.registers.get(key)
	const read = held === undefined ? undefined : READERS[key](held.value)

	return read === undefined ? OFFICE_SETTINGS_DEFAULTS[key] : read
}

export function officeSettingsValues(doc: OfficeSettingsDoc): OfficeSettingsValues {
	return {
		authorName: officeSetting(doc, "authorName"),
		authorInitials: officeSetting(doc, "authorInitials"),
		autosave: officeSetting(doc, "autosave"),
		autosaveDelayMs: officeSetting(doc, "autosaveDelayMs"),
		spellCheck: officeSetting(doc, "spellCheck"),
		proofingLanguage: officeSetting(doc, "proofingLanguage"),
		ignoreUppercase: officeSetting(doc, "ignoreUppercase"),
		ignoreWordsWithNumbers: officeSetting(doc, "ignoreWordsWithNumbers"),
		ignoreAddresses: officeSetting(doc, "ignoreAddresses"),
		flagRepeatedWords: officeSetting(doc, "flagRepeatedWords"),
		regionalFormat: officeSetting(doc, "regionalFormat"),
		paperSize: officeSetting(doc, "paperSize")
	}
}

// The document with `key` set to `value` at `stamp`: unchanged when the setting does not take the value, or
// already holds it. The author name is never unset (null leaves it as it is).
export function setOfficeSetting<K extends OfficeSettingKey>(
	doc: OfficeSettingsDoc,
	key: K,
	value: OfficeSettingsValues[K],
	stamp: number
): OfficeSettingsDoc {
	const read = READERS[key](value)

	if (read === undefined || (key === "authorName" && read === null)) return doc

	const held = doc.registers.get(key)

	if (held !== undefined && READERS[key](held.value) === read) return doc

	const registers = new Map(doc.registers)

	// Past the current register even when this device's clock is behind the one that set it.
	registers.set(key, { value: read, at: clampStamp(Math.max(stamp, (held?.at ?? Number.NEGATIVE_INFINITY) + 1)) })

	return { v: OFFICE_SETTINGS_VERSION, registers }
}

export function setAuthorName(doc: OfficeSettingsDoc, name: string, stamp: number): OfficeSettingsDoc {
	return setOfficeSetting(doc, "authorName", name, stamp)
}

export function setOfficeAutosave(doc: OfficeSettingsDoc, autosave: boolean, stamp: number): OfficeSettingsDoc {
	return setOfficeSetting(doc, "autosave", autosave, stamp)
}

export function officeAuthorName(doc: OfficeSettingsDoc): string | null {
	return officeSetting(doc, "authorName")
}

export function officeAutosave(doc: OfficeSettingsDoc): boolean {
	return officeSetting(doc, "autosave")
}
