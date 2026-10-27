import { type } from "arktype"
import type { DesktopPrefs } from "@filen/shared/desktop"
import { type AtomicFile, errorCode } from "./atomicFile.ts"
import { serialQueue } from "../shared/serial.ts"

export const DEFAULT_PREFS: DesktopPrefs = {
	minimizeToTray: false,
	startMinimized: false,
	launchAtLogin: false,
	notifications: true
}

const prefFields = {
	"minimizeToTray?": "boolean",
	"startMinimized?": "boolean",
	"launchAtLogin?": "boolean",
	"notifications?": "boolean"
} as const

// Every field is optional, so a pref added later reads as its default from an older file; unknown keys are dropped.
const storedPrefsSchema = type({ ...prefFields, "+": "delete" })

// What the renderer may send: known fields only.
export const prefsPatchSchema = type({ ...prefFields, "+": "reject" })

export type PrefsPatch = typeof prefsPatchSchema.infer

// A missing, unparsable or invalid file is the defaults.
export function parsePrefs(data: string | null): DesktopPrefs {
	if (data === null) {
		return DEFAULT_PREFS
	}

	let json: unknown

	try {
		json = JSON.parse(data)
	} catch {
		return DEFAULT_PREFS
	}

	const stored = storedPrefsSchema(json)

	return stored instanceof type.errors ? DEFAULT_PREFS : { ...DEFAULT_PREFS, ...stored }
}

export interface PrefsStore {
	get(): DesktopPrefs
	set(patch: PrefsPatch): Promise<DesktopPrefs>
}

// Read once at startup and served from memory. Writes run one at a time (they share the file's temp sibling); a failed
// write rejects the set and keeps the in-memory prefs as they were.
export async function loadPrefs(file: AtomicFile, warn: (message: string) => void): Promise<PrefsStore> {
	let current = DEFAULT_PREFS
	const serial = serialQueue()

	try {
		current = parsePrefs((await file.read())?.toString("utf8") ?? null)
	} catch (error) {
		warn(`prefs unreadable, using defaults: ${errorCode(error)}`)
	}

	return {
		get: () => current,
		set: patch =>
			serial(async () => {
				const next = { ...current, ...patch }

				await file.write(Buffer.from(JSON.stringify(next)))
				current = next

				return next
			})
	}
}
