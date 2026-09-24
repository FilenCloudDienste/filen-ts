import { type SdkErrorKind } from "@/lib/sdk/errorKinds.gen"

// English source catalog — "errors" namespace, keyed by the SDK's finite `SdkErrorKind` taxonomy
// (@/lib/sdk/errorKinds.gen, generated from @filen/sdk-rs@0.4.29's ErrorKind enum) so a lookup is
// a plain namespaced `i18n.exists`/`t()` call keyed on the live `kind` string — no hand-maintained
// mapping table that can drift from the SDK (see @/lib/i18n/errorLabel). `satisfies Partial<...>`
// seeds only a few representative kinds while still catching a typo'd key at compile
// time; every unseeded SdkErrorKind member (and any error with no `kind` at all — plain
// marshalling errors) falls back to `labelFirst`'s LABEL-FIRST server/inner/message chain, never a
// raw untranslated technical string.
export const errors = {
	/** Fires when the server rejects a call because the session is no longer authenticated; surfaces via errorLabel wherever the failing operation reports */
	Unauthenticated: "You're not signed in. Please sign in again.",
	/** Fires when sign-in rejects the email/password combination; shown on the sign-in form */
	EmailOrPasswordWrong: "Wrong email or password. Please try again.",
	/** Fires when a password-protected public link rejects the password entered; shown on the link's password prompt */
	WrongPassword: "Wrong password. Please try again.",
	/** Fires when an account-recovery operation rejects the recovery material it was given — reachable from the reset page's uploaded master keys file (the SDK's recoverKey parameter, hence the kind name); the label speaks master-keys language per the naming law */
	BadRecoveryKey: "The master keys file is invalid. Please check the file and try again.",
	/** Fires when sign-in requires a two-factor code and none was provided; the sign-in flow branches to its two-factor step on this kind */
	Enter2fa: "Please enter your two-factor authentication code.",
	/** Fires when an operation given an authenticator code rejects it (sign-in, enabling/disabling two-factor, account deletion); shown by the prompting form */
	Wrong2fa: "The two-factor authentication code is incorrect.",
	/** Fires when an operation references a directory the backend no longer has; surfaces via errorLabel wherever the operation reports */
	FolderNotFound: "Directory not found.",
	/** Fires when the backend cannot find the referenced file; surfaces via errorLabel wherever the operation reports */
	FileNotFound: "File not found.",
	/** Fires when an operation would exceed the account's storage limit (e.g. an upload); surfaces via errorLabel wherever the transfer reports */
	MaxStorageReached: "You have reached your maximum storage capacity.",
	/** Fires when a request could not reach the server (connection lost, DNS, timeout) after the SDK's own retries; surfaces via errorLabel wherever the operation reports, e.g. a copy's failed items */
	Reqwest: "Network error. Please check your connection and try again.",
	/** Fires when the server's reply could not be read (an unexpected or cut-off response); same wording as Reqwest, since both mean the request didn't go through */
	Response: "Network error. Please check your connection and try again.",
	/** Fires when the server rejected a call without a message of its own; one that sent a message shows that message instead (see errorLabel) */
	Server: "The server returned an error. Please try again later.",
	/** Fires when a file's stored data is missing on the server, e.g. the file was deleted after the listing was loaded; worded without claiming the file is gone */
	FileChunkNotFound: "This file's data could not be found on the server. It may have been deleted.",
	/** Fires when reading or writing local data failed (e.g. browser storage) */
	IO: "Could not read or write a file on this device.",
	/** Fires on an unexpected failure inside the app's file engine */
	Internal: "An internal error occurred. Please try again.",
	/** Fires when an action can't run in the current state of the item or the app */
	InvalidState: "This action can't be completed right now. Please try again.",
	/** Fires when data could not be converted while being processed (e.g. an unexpected format) */
	Conversion: "Something went wrong while processing your data.",
	/** Fires when the SDK rejects a file/directory name (rename, create directory, new text file, move-picker create, upload). The SDK collapses several distinct causes into this one kind, so this message summarises the whole rule set instead of naming one cause; it replaces the raw, English-only detail string that surfaced through labelFirst before */
	InvalidName:
		"That name can't be used. A name can't contain \\ / : * ? \" < > |, can't start or end with a space, can't end with a dot, and must be 255 bytes or shorter."
} as const satisfies Partial<Record<SdkErrorKind, string>>
