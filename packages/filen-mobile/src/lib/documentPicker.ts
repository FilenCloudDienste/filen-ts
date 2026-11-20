import { Platform } from "react-native"
import * as DocumentPicker from "expo-document-picker"
import * as FileSystem from "expo-file-system"
import { withSystemPresentation } from "@/lib/systemPresentation"
import { newTmpPickFile } from "@/lib/tmp"
import logger from "@/lib/logger"

/**
 * The single entry point for picking documents. Nothing else may import expo-document-picker
 * directly (enforced by eslint.config.mjs), because the module has two footguns that are easy to
 * reintroduce at a new call site:
 *
 *  1. It has to be wrapped in `withSystemPresentation`, or the picker's own presentation trips the
 *     privacy cover and the biometric re-lock on the way out.
 *  2. `copyToCacheDirectory` has to differ per platform — see COPY_TO_CACHE_DIRECTORY below.
 *  3. The picked files have to be moved somewhere the system won't delete them — see stagePicks.
 *
 * Silent by design: this module never alerts or toasts. Callers own the UX, and own deleting the
 * files they are handed.
 */

export type PickedDocument = {
	uri: string
	name: string
	mimeType?: string
	size?: number
	lastModified: number
}

export type PickDocumentsResult =
	| {
			canceled: true
			documents: null
	  }
	| {
			canceled: false
			documents: PickedDocument[]
	  }

export type PickDocumentsOptions = {
	type: string | string[]
	multiple: boolean
}

/**
 * iOS constructs its picker with `asCopy: true` unconditionally, so the URL handed to the delegate
 * is ALREADY an app-owned copy, at tmp/<bundle-id>-Inbox/<name> — no security-scoped access needed.
 * Leaving copyToCacheDirectory on there makes the module copy those bytes a second time, on the
 * main thread inside the UIKit delegate callback. Turning it off skips the redundant copy and
 * halves peak disk for large picks. That Inbox copy is not ours to keep, though: see stagePicks.
 *
 * Android keeps it ON. With it off the module returns the raw SAF `content://` URI, and copying
 * that ourselves would run through expo-file-system's FileChannel path, which reports success
 * having written nothing when a provider backs the URI with a pipe — which cloud providers do for
 * read-only opens. The module's own copy is a stream copy that handles pipes correctly; the
 * patch in patches/ is what moves it off the main thread.
 */
const COPY_TO_CACHE_DIRECTORY = Platform.OS === "android"

// Best-effort: a pick that fails part-way must not leak the files it was handed.
function deleteQuietly(uris: string[]): void {
	for (const uri of uris) {
		try {
			const file = new FileSystem.File(uri)

			if (file.exists) {
				file.delete()
			}
		} catch (e) {
			logger.warn("documentPicker", "failed to delete picked file", { error: e })
		}
	}
}

/**
 * Moves every picked file into filen-tmp/document-picks/ before anything reads it.
 *
 * iOS: when UIKit delivers an asCopy pick it schedules the Inbox file for deletion about 60 s later
 * (undocumented; it runs in our process, and on resume if the app was backgrounded). An upload
 * still reading a large file, or a note import waiting on its name prompt, then finds the path
 * gone, and the SDK reports that as "modified during upload" after every byte was sent. Once the
 * file has been moved, the cleanup finds nothing at the Inbox path and skips the delete.
 * Android: the module's copies sit in Caches/DocumentPicker/, which "Clear sandbox cache" wipes
 * without waiting for transfers; filen-tmp is excluded from it.
 *
 * Both sources are on the same volume as filen-tmp, so each move is a rename. It has to run right
 * after the picker resolves: no prompt, network call or quota check may come first. The uuid names
 * also stop a later pick from overwriting an earlier one still in flight. The staged file keeps
 * the source extension (drive upload's HEIC check reads it); every other field comes from the
 * picker. On failure every picked file, moved or not, is deleted before the error is rethrown.
 */
async function stagePicks(documents: PickedDocument[]): Promise<PickedDocument[]> {
	const staged: PickedDocument[] = []

	try {
		for (const document of documents) {
			const source = new FileSystem.File(document.uri)
			const destination = newTmpPickFile(source.extension)

			await source.move(destination)

			staged.push({
				...document,
				uri: destination.uri
			})
		}
	} catch (e) {
		logger.error("documentPicker", "failed to stage picked documents", {
			error: e,
			count: documents.length,
			staged: staged.length
		})

		deleteQuietly([...staged.map(document => document.uri), ...documents.slice(staged.length).map(document => document.uri)])

		throw e
	}

	return staged
}

export async function pickDocuments(options: PickDocumentsOptions): Promise<PickDocumentsResult> {
	const result = await withSystemPresentation(() =>
		DocumentPicker.getDocumentAsync({
			type: options.type,
			multiple: options.multiple,
			copyToCacheDirectory: COPY_TO_CACHE_DIRECTORY
			// `base64` is deliberately not passed — it is a web-only option and both native
			// option records discard it.
		})
	)

	if (result.canceled) {
		return {
			canceled: true,
			documents: null
		}
	}

	const documents = result.assets.map(asset => ({
		uri: asset.uri,
		name: asset.name,
		mimeType: asset.mimeType,
		size: asset.size,
		lastModified: asset.lastModified
	}))

	// On iOS the picker hands back the system's own asCopy Inbox URLs, and Apple documents no
	// uniqueness guarantee for two identically-named files picked in one selection. A collision would
	// mean the second copy clobbered the first and we'd silently upload one file's bytes twice, so
	// fail loudly instead. Checked on the picker's URIs, before staging gives each a unique name.
	// Duplicate URIs are never valid on either platform, so this is checked unconditionally.
	if (new Set(documents.map(document => document.uri)).size !== documents.length) {
		logger.error("documentPicker", "picker returned duplicate uris", {
			count: documents.length,
			names: documents.map(document => document.name)
		})

		deleteQuietly(documents.map(document => document.uri))

		throw new Error("Document picker returned duplicate URIs")
	}

	const stagedDocuments = await stagePicks(documents)

	// Breadcrumb only (in-memory unless an error later drags it to disk). There is no network log
	// sink, so if a pick misbehaves this is the only record of how much was picked.
	logger.debug("documentPicker", "picked documents", {
		count: stagedDocuments.length,
		totalBytes: stagedDocuments.reduce((total, document) => total + (document.size ?? 0), 0)
	})

	return {
		canceled: false,
		documents: stagedDocuments
	}
}

export default pickDocuments
