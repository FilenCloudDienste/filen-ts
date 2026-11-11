import { type } from "arktype"
import type { DesktopPrefs } from "@filen/shared/desktop"
import { DEFAULT_DESKTOP_LOCK_AFTER_SECONDS, DESKTOP_LOCK_AFTER_SECONDS } from "@filen/shared/desktopLock"
import { type AtomicFile, errorCode } from "./atomicFile.ts"
import { absolutePathSchema } from "../shared/nativeProtocol.ts"
import { serialQueue } from "../shared/serial.ts"

export const DEFAULT_PREFS: DesktopPrefs = {
	minimizeToTray: false,
	startMinimized: false,
	launchAtLogin: false,
	lockAfterSeconds: DEFAULT_DESKTOP_LOCK_AFTER_SECONDS,
	chatNotifications: true,
	contactNotifications: true,
	syncNotifications: true,
	// Silent unless the user opts in: notifications carry no sound by default.
	notificationSound: false,
	downloadDirectory: null
}

// What the renderer may send: known fields only, each optional. It may reset the download directory to "ask", never
// set a path: only main's own directory picker does (`setDownloadDirectory`).
export const prefsPatchSchema = type({
	"minimizeToTray?": "boolean",
	"startMinimized?": "boolean",
	"launchAtLogin?": "boolean",
	"lockAfterSeconds?": type.enumerated(...DESKTOP_LOCK_AFTER_SECONDS),
	"chatNotifications?": "boolean",
	"contactNotifications?": "boolean",
	"syncNotifications?": "boolean",
	"notificationSound?": "boolean",
	"downloadDirectory?": "null",
	"+": "reject"
})

export type PrefsPatch = typeof prefsPatchSchema.infer

// What the file may hold: the page's fields plus a stored download directory.
const storedPrefsSchema = prefsPatchSchema.omit("downloadDirectory").merge({
	"downloadDirectory?": absolutePathSchema.or("null"),
	"+": "reject"
})

// A missing or unparsable file is the defaults. Each field is checked on its own, so a pref added later reads as its
// default from an older file, and one invalid value (an edited file, a choice no longer offered) resets only itself;
// unknown keys are dropped.
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

	if (typeof json !== "object" || json === null || Array.isArray(json)) {
		return DEFAULT_PREFS
	}

	const prefs = { ...DEFAULT_PREFS }

	for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
		const field = storedPrefsSchema({ [key]: value })

		if (!(field instanceof type.errors)) {
			Object.assign(prefs, field)
		}
	}

	return prefs
}

export interface PrefsStore {
	get(): DesktopPrefs
	set(patch: PrefsPatch): Promise<DesktopPrefs>
	// An absolute path chosen in main's directory picker, or null to ask every time.
	setDownloadDirectory(path: string | null): Promise<DesktopPrefs>
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

	function apply(patch: Partial<DesktopPrefs>): Promise<DesktopPrefs> {
		return serial(async () => {
			const next = { ...current, ...patch }

			await file.write(Buffer.from(JSON.stringify(next)))
			current = next

			return next
		})
	}

	return {
		get: () => current,
		set: apply,
		setDownloadDirectory: downloadDirectory => {
			if (downloadDirectory !== null && !absolutePathSchema.allows(downloadDirectory)) {
				return Promise.reject(new Error("invalid download directory"))
			}

			return apply({ downloadDirectory })
		}
	}
}
