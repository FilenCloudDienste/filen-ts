import * as Comlink from "comlink"
import { useSyncExternalStore } from "react"
import {
	OFFICE_SETTINGS_FILE_NAME,
	OfficeSettingsVersionError,
	emptyOfficeSettings,
	mergeOfficeSettings,
	normalizeAuthorName,
	officeAuthorName,
	officeAutosave,
	parseOfficeSettings,
	sameOfficeSettings,
	serializeOfficeSettings,
	setAuthorName,
	setOfficeAutosave,
	type OfficeSettingsDoc
} from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { log } from "@/lib/log"
import { registerSocketHandler } from "@/lib/sdk/socket"
import { onDotFilenSubdirForgotten } from "@/lib/dotFilen"
import { OFFICE_DIR_NAME, officeDirectory } from "@/features/office/lib/officeDirectory"
import { SYNCED_FILE_UPLOAD_DEADLINE_MS, SyncedDotFilenFile, type SyncedFileCodec } from "@/lib/syncedDotFilenFile"

// The user's document-editing settings (the author name comments and tracked changes carry, autosave), synced
// end-to-end encrypted as `.filen/office/settings.v1.json` beside the spelling dictionary
// (lib/syncedDotFilenFile.ts). Read when an editor or the settings page first needs them.

const CODEC: SyncedFileCodec<OfficeSettingsDoc> = {
	fileName: OFFICE_SETTINGS_FILE_NAME,
	// Two short settings; anything this large is not the format.
	maxBytes: 64 * 1024,
	scope: "office",
	empty: emptyOfficeSettings,
	parse: parseOfficeSettings,
	isNewerFormat: error => error instanceof OfficeSettingsVersionError,
	serialize: serializeOfficeSettings,
	merge: mergeOfficeSettings,
	same: sameOfficeSettings
}

export const officeSettings = /* @__PURE__ */ new SyncedDotFilenFile<OfficeSettingsDoc>(
	{
		...officeDirectory,
		upload: (parent, bytes) =>
			runOp(
				sdkApi.uploadFileBytes(parent, Comlink.transfer(bytes, [bytes.buffer]), OFFICE_SETTINGS_FILE_NAME, "application/json", {
					deadlineMs: SYNCED_FILE_UPLOAD_DEADLINE_MS,
					abortToken: crypto.randomUUID()
				})
			)
	},
	CODEC
)

export interface OfficeSettingsView {
	// Null until the user gave one (never filled in from the account).
	authorName: string | null
	autosave: boolean
	// The file was read this session: an unset author name really is unset.
	loaded: boolean
}

let cached: { doc: OfficeSettingsDoc; loaded: boolean; view: OfficeSettingsView } | null = null

function view(): OfficeSettingsView {
	const doc = officeSettings.value()
	const loaded = officeSettings.isLoaded

	if (cached?.doc !== doc || cached.loaded !== loaded) {
		cached = { doc, loaded, view: { authorName: officeAuthorName(doc), autosave: officeAutosave(doc), loaded } }
	}

	return cached.view
}

function subscribe(listener: () => void): () => void {
	return officeSettings.subscribe(listener)
}

// Starts reading the file (once per session, again after another session saved it); failures are logged and
// the defaults stay in effect.
export function loadOfficeSettings(): Promise<void> {
	return officeSettings.load().catch((error: unknown) => {
		log.warn("office", "office settings not loaded", { error })
	})
}

export function useOfficeSettings(): OfficeSettingsView {
	return useSyncExternalStore(subscribe, view, view)
}

export function saveAuthorName(name: string): Promise<void> {
	return officeSettings.change(doc => setAuthorName(doc, name, Date.now()))
}

export function saveOfficeAutosave(autosave: boolean): Promise<void> {
	return officeSettings.change(doc => setOfficeAutosave(doc, autosave, Date.now()))
}

let asking: Promise<string | null> | null = null

// What `ask` answers, or null once `signal` aborts (whoever asked is gone: the question is dropped, never left
// waiting for an answer that cannot come).
function answered(ask: () => Promise<string | null>, signal: AbortSignal | undefined): Promise<string | null> {
	if (signal === undefined) {
		return ask()
	}

	if (signal.aborted) {
		return Promise.resolve(null)
	}

	return new Promise<string | null>((resolve, reject) => {
		const abort = (): void => {
			resolve(null)
		}

		signal.addEventListener("abort", abort, { once: true })
		ask()
			.then(resolve, reject)
			.finally(() => {
				signal.removeEventListener("abort", abort)
			})
	})
}

// The author name a change that records one (a comment, a tracked change) carries: the setting, or asked
// once through `ask` when the user has not given one (never filled in from the account). Null when the user
// declined, when `signal` aborted (the editor asking closed) or when asking failed: the change is not made,
// and the next one asks again. Concurrent callers share one question.
export function ensureAuthorName(ask: () => Promise<string | null>, signal?: AbortSignal): Promise<string | null> {
	if (signal?.aborted === true) {
		return Promise.resolve(null)
	}

	asking ??= (async () => {
		await loadOfficeSettings()

		const current = officeAuthorName(officeSettings.value())

		if (current !== null) {
			return current
		}

		const answer = await answered(ask, signal)
		const name = answer === null ? undefined : normalizeAuthorName(answer)

		if (name === undefined) {
			return null
		}

		// Shown at once; the upload continues on its own.
		saveAuthorName(name).catch((error: unknown) => {
			log.warn("office", "author name not saved", { error })
		})

		return name
	})()
		.catch((error: unknown) => {
			log.warn("office", "author name not asked", { error })

			return null
		})
		.finally(() => {
			asking = null
		})

	return asking
}

// Called once by the authed shell's socket host.
export function registerOfficeSettingsSocketHandlers(): () => void {
	const unregister = [
		registerSocketHandler("drive", event => {
			officeSettings.handleDriveEvent(event)
		}),
		registerSocketHandler("driveMalformed", () => {
			officeSettings.markStale()
		}),
		registerSocketHandler("reconnecting", () => {
			officeSettings.markStale()
		}),
		onDotFilenSubdirForgotten(OFFICE_DIR_NAME, () => {
			officeSettings.markStale()
		})
	]

	return () => {
		for (const off of unregister) off()
	}
}
