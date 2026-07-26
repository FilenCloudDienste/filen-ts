import { Platform } from "react-native"
import * as DocumentPicker from "expo-document-picker"
import { withSystemPresentation } from "@/lib/systemPresentation"
import logger from "@/lib/logger"

/**
 * The single entry point for picking documents. Nothing else may import expo-document-picker
 * directly (enforced by eslint.config.mjs), because the module has two footguns that are easy to
 * reintroduce at a new call site:
 *
 *  1. It has to be wrapped in `withSystemPresentation`, or the picker's own presentation trips the
 *     privacy cover and the biometric re-lock on the way out.
 *  2. `copyToCacheDirectory` has to differ per platform — see COPY_TO_CACHE_DIRECTORY below.
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
 * is ALREADY an app-owned copy in the app's tmp directory — no security-scoped access needed.
 * Leaving copyToCacheDirectory on there makes the module copy those bytes a second time, on the
 * main thread inside the UIKit delegate callback. Turning it off skips the redundant copy and
 * halves peak disk for large picks. Those copies sit in the app's tmp directory, which the system
 * purges on its own schedule, so a picked iOS URI must never be persisted across launches — read
 * it within the same session or move it somewhere durable first.
 *
 * Android keeps it ON. With it off the module returns the raw SAF `content://` URI, and copying
 * that ourselves would run through expo-file-system's FileChannel path, which reports success
 * having written nothing when a provider backs the URI with a pipe — which cloud providers do for
 * read-only opens. The module's own copy is a stream copy that handles pipes correctly; the
 * patch in patches/ is what moves it off the main thread.
 */
const COPY_TO_CACHE_DIRECTORY = Platform.OS === "android"

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

	// On iOS we now hand back the system's own asCopy temp URLs instead of the module-generated
	// unique names we used to get, and Apple documents no uniqueness guarantee for two
	// identically-named files picked in one selection. A collision would mean the second copy
	// clobbered the first and we'd silently upload one file's bytes twice, so fail loudly instead.
	// Duplicate URIs are never valid on either platform, so this is checked unconditionally.
	if (new Set(documents.map(document => document.uri)).size !== documents.length) {
		logger.error("documentPicker", "picker returned duplicate uris", {
			count: documents.length,
			names: documents.map(document => document.name)
		})

		throw new Error("Document picker returned duplicate URIs")
	}

	// Breadcrumb only (in-memory unless an error later drags it to disk). There is no network log
	// sink, so if a pick misbehaves this is the only record of how much was picked.
	logger.debug("documentPicker", "picked documents", {
		count: documents.length,
		totalBytes: documents.reduce((total, document) => total + (document.size ?? 0), 0)
	})

	return {
		canceled: false,
		documents
	}
}

export default pickDocuments
