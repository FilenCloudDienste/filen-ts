import { type SdkErrorKind } from "@/lib/sdk/errorKinds.gen"

// English source catalog — "errors" namespace, keyed by the SDK's finite `SdkErrorKind` taxonomy
// (@/lib/sdk/error-kinds.gen, generated from @filen/sdk-rs@0.4.29's ErrorKind enum) so a lookup is
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
	MaxStorageReached: "You have reached your maximum storage capacity."
} as const satisfies Partial<Record<SdkErrorKind, string>>
