import { FilenSdkError, ErrorKind } from "@filen/sdk-rs"
import i18n from "@/lib/i18n"

export function unwrapSdkError(error: unknown): FilenSdkError | null {
	if (FilenSdkError.hasInner(error)) {
		const inner = FilenSdkError.getInner(error)

		return inner
	}

	return null
}

export function isNetworkClassError(error: unknown): boolean {
	const unwrapped = unwrapSdkError(error)

	if (!unwrapped) {
		return false
	}

	const kind = unwrapped.kind()

	return kind === ErrorKind.Reqwest || kind === ErrorKind.RetryFailed || kind === ErrorKind.Response
}

// An SDK error whose root cause is a recoverable authentication state rather than a permanent
// rejection. The SDK surfaces `api_key_not_found` (e.g. right after a password change, before the
// client re-authenticates) as `ErrorKind.Unauthenticated`. Callers that DROP inflight work on a
// non-network SDK error (notes sync, #40) must treat this as keep-for-retry: the edit is valid and
// will succeed once the session refreshes. The SDK only exposes `kind()`/`message()` (no API code),
// so `kind() === Unauthenticated` is the strongest structured signal available here.
export function isRetryableAuthError(error: unknown): boolean {
	const unwrapped = unwrapSdkError(error)

	if (!unwrapped) {
		return false
	}

	return unwrapped.kind() === ErrorKind.Unauthenticated
}

// Produces the user-facing string for an SDK error. SERVER/API errors show the server's own
// human message (`serverMessage()`, SDK 0.4.26+); everything else shows the raw inner Rust
// message (`innerMessage()`, e.g. "No such file or directory") — both far more readable than the
// developer-oriented `message()` Display wrapper ("Error of kind X: …"). The translated kind
// label is only the last-resort fallback when neither is available. Module level (not a hook) →
// uses the imported module `i18n`.
export function unwrappedSdkErrorToHumanReadable(unwrapped: FilenSdkError): string {
	const errorKey = (() => {
		switch (unwrapped.kind()) {
			case ErrorKind.BadRecoveryKey: {
				return "bad_recovery_key" as const
			}

			case ErrorKind.FolderNotFound: {
				return "directory_not_found" as const
			}

			case ErrorKind.WrongPassword: {
				return "wrong_password" as const
			}

			case ErrorKind.Cancelled: {
				return "operation_cancelled" as const
			}

			case ErrorKind.ChunkTooLarge: {
				return "chunk_too_large" as const
			}

			case ErrorKind.Conversion: {
				return "conversion_error" as const
			}

			case ErrorKind.FileChangedDuringSync: {
				return "file_changed_during_sync" as const
			}

			case ErrorKind.HeifError: {
				return "heif_error" as const
			}

			case ErrorKind.ImageError: {
				return "image_error" as const
			}

			case ErrorKind.InsufficientMemory: {
				return "insufficient_memory" as const
			}

			case ErrorKind.Internal: {
				return "internal_error" as const
			}

			case ErrorKind.InvalidName: {
				return "invalid_name" as const
			}

			case ErrorKind.InvalidState: {
				return "invalid_state" as const
			}

			case ErrorKind.InvalidType: {
				return "invalid_type" as const
			}

			case ErrorKind.Io: {
				return "fs_io_error" as const
			}

			case ErrorKind.MaxStorageReached: {
				return "max_remote_storage_reached" as const
			}

			case ErrorKind.MetadataWasNotDecrypted: {
				return "metadata_was_not_decrypted" as const
			}

			case ErrorKind.Reqwest: {
				return "network_error" as const
			}

			case ErrorKind.Response: {
				return "network_error" as const
			}

			case ErrorKind.RetryFailed: {
				return "network_retry_failed" as const
			}

			case ErrorKind.Server: {
				return "server_error" as const
			}

			case ErrorKind.Unauthenticated: {
				return "unauthenticated" as const
			}

			case ErrorKind.Walk: {
				return "fs_directory_walk_error" as const
			}

			default: {
				return "error_generic" as const
			}
		}
	})()

	// Server/API errors → the server's own human-readable message.
	const serverMessage = unwrapped.serverMessage()

	if (serverMessage) {
		return serverMessage
	}

	// Non-server errors → the raw inner Rust message (e.g. "No such file or directory"). Skipped
	// for server/API errors (a `code` is set, or the generic `Server` kind) so we never surface
	// the raw "API Error, message: None, code: …" inner — those fall through to the label below.
	if (unwrapped.serverCode() === undefined && unwrapped.kind() !== ErrorKind.Server) {
		const innerMessage = unwrapped.innerMessage()

		if (innerMessage) {
			return innerMessage
		}
	}

	// Fallback: the translated kind label (no server/inner message available).
	return i18n.t(errorKey)
}
