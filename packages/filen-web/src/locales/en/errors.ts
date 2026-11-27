import { type SdkErrorKind } from "@/lib/sdk/errorKinds.gen"
import type { MediaErrorKind } from "@/lib/media/mediaFailure"
import type { DOWNLOAD_GONE, DOWNLOAD_NEEDS_RELOAD, DOWNLOAD_STALLED, DOWNLOAD_WORKER_UNAVAILABLE, NAME_TAKEN } from "@/lib/sdk/errors"

// English source catalog — "errors" namespace, keyed by the SDK's finite `SdkErrorKind` taxonomy
// (@/lib/sdk/errorKinds.gen, generated from @filen/sdk-rs's ErrorKind enum) so a lookup is
// a plain namespaced `i18n.exists`/`t()` call keyed on the live `kind` string — no hand-maintained
// mapping table that can drift from the SDK (see @/lib/i18n/errorLabel). `satisfies Partial<...>`
// labels the kinds a user can meet while still catching a typo'd key at compile time. A kind with no
// entry here (internal ones such as Walk, Conversion or InvalidState, and any error with no `kind` at
// all — plain marshalling errors) falls back to `labelFirst`'s LABEL-FIRST server/inner/message chain,
// which can be the SDK's own English message. The app's own media failure kinds (lib/media/mediaFailure.ts)
// are labelled here too, so every player shows one wording, as are the download kinds of lib/sdk/errors.ts.
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
	/** Fires when a file's downloaded content does not match the checksum stored with it, which fails its download, copy, compress or extract; retrying does not help */
	ContentHashMismatch: "This file's content doesn't match its stored checksum. It may be damaged.",
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
		"That name can't be used. A name can't contain \\ / : * ? \" < > |, can't start or end with a space, can't end with a dot, and must be 255 bytes or shorter.",
	/** Fires when an archive being listed or extracted turns out to be damaged or not what its format claims; shown wherever the archive job reports */
	ArchiveCorrupt: "This archive is damaged.",
	/** Fires when an archive uses a format or feature (e.g. a compression method) the extractor can't read; shown wherever the archive job reports */
	ArchiveUnsupported: "This archive format isn't supported.",
	/** Fires when extracting would pass a safety limit: more items than allowed, more data than the decompression-bomb guard lets through, or a decoder needing more memory than the browser budget */
	ArchiveTooLarge: "This archive is too large to extract here.",
	/** Fires when a compress format's encoder needs more than the archive memory set in Advanced settings (also, rarely, when the browser can't hold a very large response) */
	InsufficientMemory: "This needs more archive memory than Advanced settings allow. Raise it there, or choose another format.",
	/** Fires when a request kept failing after the SDK's own retries; on the web mostly while taking the account lock, which another device or tab may be holding; the operation can simply be tried again */
	RetryFailed: "Another device may be changing this right now, or the connection is unstable. Please try again.",
	/** Fires when an item's metadata could not be decrypted (made with a different key or damaged); surfaces via errorLabel wherever the operation reports */
	MetadataWasNotDecrypted: "This item could not be decrypted. It may have been created with a different account or key.",
	/** Fires when an image could not be decoded (e.g. for a thumbnail or an image conversion); surfaces via errorLabel wherever the operation reports */
	ImageError: "This image couldn't be read.",
	/** Fires when a HEIC/HEIF image could not be decoded; surfaces via errorLabel wherever the operation reports */
	HeifError: "This HEIC image couldn't be read.",
	/** Fires when the item changed elsewhere (another device or tab) while an operation was working on it; the operation can be tried again */
	StaleState: "This changed elsewhere in the meantime. Please try again.",
	/** Fires when a file changed while it was being transferred; the transfer can be tried again */
	FileChangedDuringSync: "This file changed while it was being transferred. Please try again.",
	/** Fires when a piece of a file is larger than the transfer format allows (the file is damaged or was stored by an incompatible app) */
	ChunkTooLarge: "This file is damaged or in a format Filen can't transfer.",
	/** Fires when a write lost the account lock it held (e.g. the tab slept past the lock's lease, or another device took it); the write stopped part way and can simply be tried again */
	LockLost: "Another device may be changing this right now. Please try again.",
	/** Fires when the background worker running an archive job stopped mid-job (e.g. it ran out of memory) */
	ArchiveWorkerDied: "The archive worker stopped unexpectedly. Please try again.",
	/** Fires when an encrypted archive is opened, or a compress asks for encryption, without a password; the extract flow prompts for one on this kind */
	ArchivePasswordRequired: "This archive needs a password.",
	/** Fires when the password given for an encrypted archive is wrong; the extract flow prompts again on this kind */
	ArchiveWrongPassword: "Wrong password. Please try again.",
	/** Fires when opening one file of a solid 7z archive would decode more of the archive before it than the app accepted */
	ArchiveSolidSkipExceeded: "Opening this file means reading a large part of the archive first.",
	/** Raised by the app (not the SDK) when the browser can't decode a video/audio file's format or codec; shown in the preview, a chat embed and the music player's error line */
	MediaFormatUnsupported: "This file's format can't be played here.",
	/** Raised by the app (not the SDK) when a video/audio file stopped playing for any other reason (the stream broke, the file couldn't be read); shown wherever the player reports */
	MediaPlaybackFailed: "This file couldn't be played.",
	/** Raised by the app (not the SDK) when a download starts on a page the service worker does not control (after a hard reload), which cannot save a streamed file; shown wherever the download reports (a drive download, Download as, an archive entry) */
	DownloadNeedsReload: "Reload Filen to download files.",
	/** Raised by the app (not the SDK) when the browser's background download helper restarted before the download began, so the download can't continue; shown on the download's row in transfers */
	DownloadGone: "This download is no longer available. Please try again.",
	/** Raised by the app (not the SDK) when a download running in the browser's download manager stopped reporting progress for a long time; shown on the download's row in transfers */
	DownloadStalled: "The download stopped responding. Please try again.",
	/** Raised by the app (not the SDK) when the browser's background download helper is missing, did not answer or refused the download; shown on the download's row in transfers */
	DownloadWorkerUnavailable: "The download couldn't start. Please try again.",
	/** Raised by the app from the server's answer when an item can't take a name because another item in that directory already has it (a move, rename or restore); shown wherever the operation reports */
	NameTaken: "An item with this name already exists in that directory."
} as const satisfies Partial<
	Record<
		| SdkErrorKind
		| typeof NAME_TAKEN
		| MediaErrorKind
		| typeof DOWNLOAD_NEEDS_RELOAD
		| typeof DOWNLOAD_GONE
		| typeof DOWNLOAD_STALLED
		| typeof DOWNLOAD_WORKER_UNAVAILABLE,
		string
	>
>
