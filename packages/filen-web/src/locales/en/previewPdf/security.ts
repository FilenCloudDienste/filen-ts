// "preview" namespace, PDF editor — security: the Protect document dialog and the owner-password unlock. Spread into
// preview.ts; same catalog rules.
export const previewPdfSecurity = {
	/** Title of the dialog choosing a PDF's password and restrictions */
	previewPdfSecurityTitle: "Protect document",
	/** Protect document dialog: description under the title */
	previewPdfSecurityBody: "Choose who can open this PDF and what they can do with it. Changes apply when you save.",
	/** Protect document dialog: label of the group of protection choices */
	previewPdfSecurityModeLabel: "Protection",
	/** Protect document dialog choice: the PDF is not encrypted */
	previewPdfSecurityModeNone: "No password",
	/** Protect document dialog choice: opening the PDF needs a password */
	previewPdfSecurityModeOpen: "Password to open",
	/** Protect document dialog choice: the PDF opens freely (or with an optional password) but limits printing, copying and changes unless the owner password is entered */
	previewPdfSecurityModeRestrict: "Restrict editing",
	/** Protect document dialog: label of the password to open (Password to open choice) */
	previewPdfSecurityPassword: "Password",
	/** Protect document dialog: label of the field repeating the password */
	previewPdfSecurityConfirm: "Confirm password",
	/** Protect document dialog: hint under the password fields when the PDF already has a password of this kind */
	previewPdfSecurityKeepHint: "Leave blank to keep the current password.",
	/** Protect document dialog (Restrict editing): label of the password that lifts the restrictions */
	previewPdfSecurityOwnerPassword: "Owner password",
	/** Protect document dialog (Restrict editing): label of the field repeating the owner password */
	previewPdfSecurityOwnerConfirm: "Confirm owner password",
	/** Protect document dialog (Restrict editing): label of the optional password needed to open the PDF */
	previewPdfSecurityOpenPassword: "Password to open (optional)",
	/** Protect document dialog (Restrict editing): label of the field repeating the optional password to open */
	previewPdfSecurityOpenConfirm: "Confirm password to open",
	/** Protect document dialog (Restrict editing): heading of the checkboxes of what everyone may still do */
	previewPdfSecurityAllowed: "Allowed without the owner password",
	/** Protect document dialog (Restrict editing): checkbox allowing printing */
	previewPdfSecurityAllowPrint: "Printing",
	/** Protect document dialog (Restrict editing): checkbox allowing copying text and images */
	previewPdfSecurityAllowCopy: "Copying",
	/** Protect document dialog (Restrict editing): checkbox allowing editing, comments, form filling and page changes */
	previewPdfSecurityAllowChange: "Changes",
	/** Protect document dialog: note under the choices; AES-256 is the encryption method, keep it as is */
	previewPdfSecurityAes: "New passwords encrypt the file with AES-256.",
	/** Protect document dialog (Restrict editing): restrictions are only a request to other apps (exact wording) */
	previewPdfSecurityAdvisory:
		"Restrictions ask other apps to limit editing and printing. They don't encrypt the file; only a password to open does.",
	/** Protect document dialog: checkbox shown for a PDF encrypted with RC4 (exact wording; AES-256 is the encryption method, keep it as is) */
	previewPdfSecurityUpgrade: "This PDF uses outdated encryption. Upgrade to AES-256 when you save?",
	/** Protect document dialog: why the RC4 upgrade checkbox is off; the file's own passwords can't be carried over */
	previewPdfSecurityUpgradeUnavailable: "To upgrade, unlock with the owner password or set new passwords.",
	/** Protect document dialog (No password): what saving does to a PDF that has a password or restrictions */
	previewPdfSecurityRemoveNote: "Saving removes the password and restrictions.",
	/** Button next to the owner restriction text opening the owner password prompt */
	previewPdfSecurityUnlockAction: "Unlock",
	/** Protect document dialog: error under the repeated password */
	previewPdfSecurityMismatch: "The passwords don't match.",
	/** Protect document dialog: error under a password PDF encryption refuses (it holds a prohibited character) */
	previewPdfSecurityRefused: "This password has a character PDF encryption can't use.",
	/** Protect document dialog (Restrict editing): error when the owner password equals the password to open */
	previewPdfSecuritySame: "The owner password must differ from the password to open.",
	/** Protect document dialog: submit button */
	previewPdfSecurityApply: "Apply",

	/** Title of the prompt asking for a PDF's owner password, which lifts the restrictions its author set */
	previewPdfSecurityUnlockTitle: "Unlock with owner password",
	/** Owner password prompt: description under the title */
	previewPdfSecurityUnlockBody: "Enter the owner password to lift the restrictions the document's author set.",
	/** Owner password prompt: label of the password field */
	previewPdfSecurityUnlockLabel: "Owner password",
	/** Owner password prompt: error after a password that isn't the owner password */
	previewPdfSecurityUnlockWrong: "That isn't the owner password. Try again.",
	/** Item of the PDF editor's Save menu opening the Protect document dialog */
	previewPdfSecurityMenu: "Security…",
	/** Toast after the Protect document dialog was applied: the new password or restrictions are written by the next save */
	previewPdfSecurityApplied: "The new protection is applied when you save.",
	/** Toast when the chosen password or restrictions can't be applied to this PDF */
	previewPdfSecurityFailed: "This protection can't be applied to this PDF.",
	/** Toast after the owner password lifted the PDF's restrictions */
	previewPdfSecurityUnlocked: "Restrictions lifted until you close this PDF.",
	/** Button of the outdated-encryption notice under the ribbon: re-encrypt with AES-256 on the next save */
	previewPdfSecurityUpgradeAction: "Upgrade",
	/** Button of the outdated-encryption notice under the ribbon: keep the encryption as it is */
	previewPdfSecurityUpgradeDismiss: "Not now",
	/** Notice under the ribbon once the upgrade to AES-256 was chosen; AES-256 is the encryption method, keep it as is */
	previewPdfSecurityUpgradePending: "Saving re-encrypts this PDF with AES-256."
} as const
