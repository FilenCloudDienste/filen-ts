import { type SdkErrorKind } from "@/lib/sdk/error-kinds.gen"

// English source catalog — "errors" namespace, keyed by the SDK's finite `SdkErrorKind` taxonomy
// (@/lib/sdk/error-kinds.gen, generated from @filen/sdk-rs@0.4.29's ErrorKind enum) so a lookup is
// a plain namespaced `i18n.exists`/`t()` call keyed on the live `kind` string — no hand-maintained
// mapping table that can drift from the SDK (see @/lib/i18n/errorLabel). `satisfies Partial<...>`
// seeds only a FEW representative kinds for rev 1 while still catching a typo'd key at compile
// time; every unseeded SdkErrorKind member (and any error with no `kind` at all — plain
// marshalling errors) falls back to `labelFirst`'s LABEL-FIRST server/inner/message chain, never a
// raw untranslated technical string.
export const errors = {
	Unauthenticated: "You're not signed in. Please sign in again.",
	EmailOrPasswordWrong: "Wrong email or password. Please try again.",
	WrongPassword: "Wrong password. Please try again.",
	BadRecoveryKey: "The recovery key is invalid. Please double-check it and try again.",
	Enter2fa: "Please enter your two-factor authentication code.",
	Wrong2fa: "The two-factor authentication code is incorrect.",
	FolderNotFound: "Directory not found.",
	FileNotFound: "File not found.",
	MaxStorageReached: "You have reached your maximum storage capacity."
} as const satisfies Partial<Record<SdkErrorKind, string>>
