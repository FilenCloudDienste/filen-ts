// "settings" namespace — Account and Security page additions (nickname rules, personal info checks, master-keys warnings). Spread into settings.ts; same catalog rules (flat, camelCase, keys unique
// across the namespace's files, no literal '.' or ':').
export const settingsAccountFixes = {
	/** Nickname row — inline error under the field when the typed nickname breaks the server's rule (an empty field is allowed and clears the nickname) */
	settingsNicknameInvalidError: "3–32 letters, digits, spaces, _ or -",
	/** Personal information dialog — inline error under Country: the stored country is not one of the listed countries, so the server refuses every save until another is chosen */
	settingsPersonalCountryOffListError: "This country isn't on the list. Choose one from the list to save.",
	/** Personal information dialog — inline error under Country: a VAT ID was entered while no country is chosen */
	settingsPersonalVatIdNeedsCountryError: "Choose a country to go with your VAT ID.",
	/** Security page — success toast after disabling two-factor authentication */
	settingsTwoFactorDisabledSuccess: "Two-factor authentication has been disabled.",
	/** Security page — success toast after the master keys file was downloaded */
	settingsMasterKeysExportedSuccess: "Your master keys have been exported.",
	/** Security page — master keys row description while they were never exported (or a password change reset that) */
	settingsMasterKeysNotExportedWarning:
		"Please export your master keys and store them in a separate safe location. You need your master keys when you reset your password to avoid data loss. You need to export your master keys every time you change your password.",
	/** Short status read by screen readers and shown in the tooltip on the Settings entry (rail and account menu) while the master keys are not exported */
	settingsMasterKeysNotExportedStatus: "Master keys not exported"
} as const
