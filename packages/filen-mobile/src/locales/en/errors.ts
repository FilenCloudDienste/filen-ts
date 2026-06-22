// SDK error vocabulary — one key per `@filen/sdk-rs` ErrorKind (src/lib/utils.ts
// `unwrappedSdkErrorToHumanReadable` maps the finite `kind()` taxonomy to these keys). Shared
// keys live in common.ts and must not be redefined here.
//
// ERROR POLICY (Google AIP-193): only the finite, enumerable error KIND is translated via these
// keys. The open-ended `message()` diagnostic string the SDK attaches is an English/developer
// detail and is NEVER localized — it is appended raw as a parenthetical suffix. `wrong_password`
// is reused by src/lib/drive.ts (public-link password prompts) — it must not be duplicated there.
export const errors = {
	/** SDK error: the recovery key entered during 2FA / account recovery is not valid */
	bad_recovery_key: "The recovery key is invalid. Please double-check it and try again.",
	/** SDK error: a directory referenced by the operation could not be found on the server */
	directory_not_found: "Directory not found.",
	/** SDK error: the password entered (login, public link, etc.) is incorrect */
	wrong_password: "Wrong password. Please try again.",
	/** SDK error: the operation was cancelled before it finished */
	operation_cancelled: "The operation was cancelled.",
	/** SDK error: an upload chunk exceeded the maximum allowed size */
	chunk_too_large: "A part of the file is too large to upload.",
	/** SDK error: data could not be converted between the required formats */
	conversion_error: "Something went wrong while processing your data.",
	/** SDK error: a file changed on disk while it was being uploaded or synced */
	file_changed_during_sync: "The file changed while it was being synced. Please try again.",
	/** SDK error: a HEIF image could not be decoded */
	heif_error: "This HEIF image could not be processed.",
	/** SDK error: an image could not be decoded or processed */
	image_error: "This image could not be processed.",
	/** SDK error: the device ran out of memory while completing the operation */
	insufficient_memory: "Your device ran out of memory. Please close some apps and try again.",
	/** SDK error: an unexpected internal error occurred inside the SDK */
	internal_error: "An internal error occurred. Please try again.",
	/** SDK error: a file or directory name is not valid (empty, reserved, or illegal characters) */
	invalid_name: "That name is not allowed. Please choose a different one.",
	/** SDK error: the operation was attempted in a state that does not allow it */
	invalid_state: "This action cannot be completed right now. Please try again.",
	/** SDK error: an item's type does not match what the operation expects */
	invalid_type: "This item type is not supported for this action.",
	/** SDK error: a local file-system read/write failed */
	fs_io_error: "Could not read or write a file on your device.",
	/** SDK error: the account has reached its maximum cloud storage */
	max_remote_storage_reached: "You've reached your storage limit. Free up space or upgrade your plan.",
	/** SDK error: an item's encrypted metadata could not be decrypted */
	metadata_was_not_decrypted: "Some data could not be decrypted.",
	/** SDK error: a network request failed (covers both Reqwest and Response SDK kinds) */
	network_error: "Network error. Please check your connection and try again.",
	/** SDK error: a network request kept failing after the SDK exhausted its retries */
	network_retry_failed: "The request failed repeatedly. Please check your connection and try again.",
	/** SDK error: the server returned an error response */
	server_error: "The server returned an error. Please try again later.",
	/** SDK error: the request was not authenticated (session expired or missing) */
	unauthenticated: "You're not logged in. Please log in again.",
	/** SDK error: walking a local directory tree failed */
	fs_directory_walk_error: "Could not read the contents of a directory on your device.",
	/** Generic fallback for an unknown / unmapped SDK error kind */
	error_generic: "Something went wrong. Please try again."
} as const
