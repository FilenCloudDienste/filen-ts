// English source catalog — "settings" namespace: the settings sidebar (D3's Account / Security /
// Appearance / Events / Billing sections) plus the Account and Appearance section content. The
// existing "auth" namespace keeps the Security section's copy unchanged (that page ships as-is);
// this namespace never duplicates those keys. Same typed-catalog rules as every other namespace:
// flat `as const` object, camelCase keys, no literal '.' or ':' (real i18next namespaces,
// keySeparator/nsSeparator both ON).
export const settings = {
	// ── Sidebar section nav (D3) ────────────────────────────────────────────
	/** Settings sidebar — Account section nav label and that section's page heading */
	settingsSectionAccount: "Account",
	/** Settings sidebar — Security section nav label (the page itself renders its own "auth:securityTitle" heading) */
	settingsSectionSecurity: "Security",
	/** Settings sidebar — Appearance section nav label and that section's page heading */
	settingsSectionAppearance: "Appearance",
	/** Settings sidebar — Events section nav label and that section's placeholder heading (audit log ships in a later wave) */
	settingsSectionEvents: "Events",
	/** Settings sidebar — Billing section nav label and that section's placeholder heading (read-only billing ships in a later wave) */
	settingsSectionBilling: "Billing",
	/** Account page — error-state title, mirrors "auth:securityLoadError" for its own section */
	settingsAccountLoadError: "Couldn't load your account",

	// ── Placeholder sections (Events / Billing — present but minimal until a later wave) ─────
	/** Events/Billing placeholder page — body under the section title + "common:comingSoon" badge */
	settingsPlaceholderBody: "This section is on its way.",

	// ── Account: avatar ──────────────────────────────────────────────────────
	settingsAvatarTitle: "Profile picture",
	settingsAvatarDescription: "Shown next to your name across Filen",
	/** Avatar card — button that opens the file picker (also relabeled while an upload is in flight) */
	settingsAvatarChangeAction: "Change picture",
	settingsAvatarUploadSuccess: "Your profile picture has been updated.",
	/** Avatar card — rejected file type (only JPEG/PNG accepted, mirrors the file input's own `accept`) */
	settingsAvatarInvalidType: "Please choose a JPEG or PNG image.",
	/** Avatar card — rejected file size; {{max}} is a pre-formatted byte size (e.g. "2 MB") */
	settingsAvatarTooLarge: "Images must be smaller than {{max}}.",

	// ── Account: email ───────────────────────────────────────────────────────
	settingsEmailTitle: "Email address",
	settingsEmailDescription: "The address you sign in with",
	settingsEmailCurrentLabel: "Current email",
	settingsChangeEmailAction: "Change email",
	settingsChangeEmailNew: "New email",
	settingsChangeEmailConfirm: "Confirm new email",
	settingsChangeEmailPassword: "Password",
	settingsChangeEmailInvalid: "Enter a valid email address.",
	settingsChangeEmailMismatch: "The email addresses don't match.",
	/** Change-email card — success toast; the account query is refetched afterward so the displayed email updates */
	settingsChangeEmailSuccess: "Your email address has been changed. Please sign in again.",
	/** Change-email card — mirrors "auth:changePasswordPersistFailed": the mutation succeeded server-side but the local session could not be re-saved */
	settingsChangeEmailPersistFailed:
		"Your email address was changed, but the new session could not be saved on this device. Please sign in again.",

	// ── Account: nickname ────────────────────────────────────────────────────
	settingsNicknameTitle: "Nickname",
	settingsNicknameDescription: "An optional display name shown to your contacts instead of your email",
	settingsNicknamePlaceholder: "No nickname set",
	settingsNicknameSave: "Save",
	settingsNicknameSuccess: "Your nickname has been updated.",

	// ── Account: personal information ────────────────────────────────────────
	settingsPersonalTitle: "Personal information",
	settingsPersonalDescription: "Optional billing/invoice details — never shown to other users",
	settingsPersonalExpand: "Show fields",
	settingsPersonalCollapse: "Hide fields",
	settingsPersonalFirstName: "First name",
	settingsPersonalLastName: "Last name",
	settingsPersonalCompanyName: "Company name",
	settingsPersonalVatId: "VAT ID",
	settingsPersonalStreet: "Street",
	settingsPersonalStreetNumber: "Street number",
	settingsPersonalCity: "City",
	settingsPersonalPostalCode: "Postal code",
	settingsPersonalCountry: "Country",
	settingsPersonalSave: "Save",
	settingsPersonalSuccess: "Your personal information has been updated.",

	// ── Account: storage breakdown ───────────────────────────────────────────
	settingsStorageTitle: "Storage",
	/** Storage breakdown card — {{used}}/{{total}} are pre-formatted byte sizes */
	settingsStorageUsage: "{{used}} of {{total}} used",
	settingsStorageFiles: "Files",
	settingsStorageVersioned: "Versioned files",
	settingsStorageFree: "Free",

	// ── Account: GDPR export ─────────────────────────────────────────────────
	settingsGdprTitle: "Export your data",
	settingsGdprDescription: "Download a copy of your account and activity data as a JSON file",
	settingsGdprExportAction: "Export data",
	settingsGdprSuccess: "Your data export has started downloading.",

	// ── Appearance: theme ────────────────────────────────────────────────────
	settingsThemeTitle: "Theme",
	settingsThemeDescription: "Choose how Filen looks on this device",
	settingsThemeLight: "Light",
	settingsThemeDark: "Dark",
	settingsThemeSystem: "System"
} as const
