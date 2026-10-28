import * as Comlink from "comlink"
import type { SocketEvent } from "@filen/sdk-rs"
import {
	USER_DICTIONARY_FILE_NAME,
	UserDictionaryVersionError,
	addUserWord,
	emptyUserDictionary,
	mergeUserDictionaries,
	parseUserDictionary,
	removeUserWord,
	sameUserDictionary,
	serializeUserDictionary,
	userWords,
	type UserDictionaryDoc
} from "@filen/spellcheck"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { registerSocketHandler } from "@/lib/sdk/socket"
import { onDotFilenSubdirForgotten } from "@/lib/dotFilen"
import { OFFICE_DIR_NAME, officeDirectory } from "@/features/office/lib/officeDirectory"
import { SYNCED_FILE_UPLOAD_DEADLINE_MS, SyncedDotFilenFile, type SyncedFileCodec, type SyncedFileSdk } from "@/lib/syncedDotFilenFile"

// The user's spelling dictionary, synced end-to-end encrypted as `.filen/office/user-dictionary.v1.json`
// (lib/syncedDotFilenFile.ts): read when spellchecking first needs it, an addition shown at once and merged
// into the file as it stands before the upload.

export { OFFICE_DIR_NAME }

export type UserDictionarySdk = SyncedFileSdk

const CODEC: SyncedFileCodec<UserDictionaryDoc> = {
	fileName: USER_DICTIONARY_FILE_NAME,
	// Far above a full list (50k words is about 1.5 MB).
	maxBytes: 4 * 1024 * 1024,
	scope: "spellcheck",
	empty: emptyUserDictionary,
	parse: parseUserDictionary,
	isNewerFormat: error => error instanceof UserDictionaryVersionError,
	serialize: serializeUserDictionary,
	merge: mergeUserDictionaries,
	same: sameUserDictionary
}

type DriveSocketEvent = Extract<SocketEvent, { type: "drive" }>

export class UserDictionaryStore {
	private readonly file: SyncedDotFilenFile<UserDictionaryDoc>
	private readonly now: () => number
	// Replaced only when the words change, so listeners hear real changes only.
	private wordsValue: readonly string[] = []

	constructor(sdk: UserDictionarySdk, now: () => number = Date.now) {
		this.file = new SyncedDotFilenFile(sdk, CODEC, doc => {
			const words = userWords(doc)

			if (words.length !== this.wordsValue.length || words.some((word, i) => word !== this.wordsValue[i])) this.wordsValue = words
		})
		this.now = now
	}

	words(): readonly string[] {
		return this.wordsValue
	}

	subscribe(listener: (words: readonly string[]) => void): () => void {
		let heard = this.wordsValue

		return this.file.subscribe(() => {
			if (this.wordsValue === heard) return

			heard = this.wordsValue
			listener(heard)
		})
	}

	// Reads the file when this session has not, or another session changed it since.
	load(): Promise<void> {
		return this.file.load()
	}

	add(word: string): Promise<void> {
		return this.file.change(doc => addUserWord(doc, word, this.now()))
	}

	remove(word: string): Promise<void> {
		return this.file.change(doc => removeUserWord(doc, word, this.now()))
	}

	handleDriveEvent(event: DriveSocketEvent): void {
		this.file.handleDriveEvent(event)
	}

	markStale(): void {
		this.file.markStale()
	}

	reset(): void {
		this.file.reset()
	}
}

export const userDictionary = new UserDictionaryStore({
	...officeDirectory,
	upload: (parent, bytes) =>
		runOp(
			sdkApi.uploadFileBytes(parent, Comlink.transfer(bytes, [bytes.buffer]), USER_DICTIONARY_FILE_NAME, "application/json", {
				deadlineMs: SYNCED_FILE_UPLOAD_DEADLINE_MS,
				abortToken: crypto.randomUUID()
			})
		)
})

// Called once by the authed shell's socket host.
export function registerUserDictionarySocketHandlers(): () => void {
	const unregister = [
		registerSocketHandler("drive", event => {
			userDictionary.handleDriveEvent(event)
		}),
		registerSocketHandler("driveMalformed", () => {
			userDictionary.markStale()
		}),
		registerSocketHandler("reconnecting", () => {
			userDictionary.markStale()
		}),
		onDotFilenSubdirForgotten(OFFICE_DIR_NAME, () => {
			userDictionary.markStale()
		})
	]

	return () => {
		for (const off of unregister) off()
	}
}
