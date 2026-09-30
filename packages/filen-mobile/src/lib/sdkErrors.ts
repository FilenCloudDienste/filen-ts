import { FilenSdkError, ErrorKind } from "@filen/sdk-rs"
import { isNetworkClassErrorKind, isPermanentRejection } from "@filen/shared"
import i18n from "@/lib/i18n"
import { type en } from "@/locales/en"

export function unwrapSdkError(error: unknown): FilenSdkError | null {
	if (FilenSdkError.hasInner(error)) {
		const inner = FilenSdkError.getInner(error)

		return inner
	}

	return null
}

// Thin adapter over the shared kind-name allowlist: `ErrorKind` is a plain (non-`const`) numeric TS
// enum with no explicit initializers, so TypeScript emits a reverse map and `ErrorKind[u.kind()]`
// yields the member name at zero extra cost.
export function isNetworkClassError(error: unknown): boolean {
	const unwrapped = unwrapSdkError(error)

	return isNetworkClassErrorKind(unwrapped !== null ? ErrorKind[unwrapped.kind()] : undefined)
}

export function isPermanentSdkRejection(error: unknown): boolean {
	const unwrapped = unwrapSdkError(error)

	return isPermanentRejection({
		hasSdkError: unwrapped !== null,
		kind: unwrapped !== null ? ErrorKind[unwrapped.kind()] : undefined
	})
}

const ERROR_KEY_BY_KIND: Partial<Record<ErrorKind, keyof typeof en>> = {
	[ErrorKind.BadRecoveryKey]: "bad_recovery_key",
	[ErrorKind.FolderNotFound]: "directory_not_found",
	[ErrorKind.WrongPassword]: "wrong_password",
	[ErrorKind.Cancelled]: "operation_cancelled",
	[ErrorKind.ChunkTooLarge]: "chunk_too_large",
	[ErrorKind.Conversion]: "conversion_error",
	[ErrorKind.FileChangedDuringSync]: "file_changed_during_sync",
	[ErrorKind.HeifError]: "heif_error",
	[ErrorKind.ImageError]: "image_error",
	[ErrorKind.InsufficientMemory]: "insufficient_memory",
	[ErrorKind.Internal]: "internal_error",
	[ErrorKind.InvalidName]: "invalid_name",
	[ErrorKind.InvalidState]: "invalid_state",
	[ErrorKind.InvalidType]: "invalid_type",
	[ErrorKind.Io]: "fs_io_error",
	[ErrorKind.MaxStorageReached]: "max_remote_storage_reached",
	// A 404 on a stored chunk: carries no server message, and its inner text is a raw request URL.
	[ErrorKind.FileChunkNotFound]: "file_data_not_found",
	[ErrorKind.MetadataWasNotDecrypted]: "metadata_was_not_decrypted",
	[ErrorKind.Reqwest]: "network_error",
	[ErrorKind.Response]: "network_error",
	[ErrorKind.RetryFailed]: "network_retry_failed",
	[ErrorKind.Server]: "server_error",
	[ErrorKind.Unauthenticated]: "unauthenticated",
	[ErrorKind.Walk]: "fs_directory_walk_error",
	[ErrorKind.StaleState]: "stale_state",
	[ErrorKind.MissingStableUuid]: "item_not_modifiable"
}

// Produces the user-facing string for an SDK error. Priority: (1) SERVER/API errors show the
// server's own human message (`serverMessage()`, SDK 0.4.26+); (2) any KNOWN error kind shows its
// friendly localized label — this deliberately WINS over the raw inner Rust message, because for
// the network/parse/codec kinds (Reqwest/Response/Conversion/…) that inner is a technical
// reqwest/serde string ("error sending request for url …") the average user can't act on, whereas
// the label ("Network error") is clear; (3) only an UNMAPPED kind falls back to the raw inner
// message (`innerMessage()`), then the generic label. Module level (not a hook) → uses `i18n`.
// The same priority for an SDK error already read into its parts (a copy job keeps its errors that way).
export function sdkErrorPartsToHumanReadable(parts: { kind: ErrorKind; serverMessage: string | undefined; innerMessage: string | undefined }): string {
	const errorKey = ERROR_KEY_BY_KIND[parts.kind] ?? "error_generic"

	// Server/API errors → the server's own human-readable message (the most specific text we have).
	const serverMessage = parts.serverMessage

	if (serverMessage) {
		return serverMessage
	}

	// Any KNOWN kind → its friendly localized label. This wins over the raw inner Rust message:
	// for network/parse/codec kinds the inner is a technical reqwest/serde string the average user
	// can't act on, whereas the label ("Network error") is clear.
	if (errorKey !== "error_generic") {
		return i18n.t(errorKey)
	}

	// Unmapped/unknown kind → the raw inner Rust message as a better-than-generic fallback.
	const innerMessage = parts.innerMessage

	if (innerMessage) {
		return innerMessage
	}

	// Nothing better available.
	return i18n.t(errorKey)
}

export function unwrappedSdkErrorToHumanReadable(unwrapped: FilenSdkError): string {
	return sdkErrorPartsToHumanReadable({
		kind: unwrapped.kind(),
		serverMessage: unwrapped.serverMessage(),
		innerMessage: unwrapped.innerMessage()
	})
}

// Any caught value → display string, SDK errors via the label-first rule above. Without a
// `fallback`, anything that is not an Error or string is stringified.
export function errorToMessage(error: unknown, fallback?: string): string {
	const unwrapped = unwrapSdkError(error)

	if (unwrapped) {
		return unwrappedSdkErrorToHumanReadable(unwrapped)
	}

	if (error instanceof Error) {
		return error.message
	}

	if (typeof error === "string") {
		return error
	}

	return fallback ?? String(error)
}
