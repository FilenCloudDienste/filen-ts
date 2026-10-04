// English source catalog — "settings" namespace: the settings sidebar (Account / Security /
// Appearance / Events / Billing sections) plus the Account and Appearance section content. The
// "auth" namespace keeps the Security section's own copy (forms, dialogs, row titles it already had);
// this namespace only adds that page's group titles and row-layout labels, and never duplicates
// those keys. Same typed-catalog rules as every other namespace:
// flat `as const` object, camelCase keys, no literal '.' or ':' (real i18next namespaces,
// keySeparator/nsSeparator both ON).
export const settings = {
	// ── Sidebar section nav ────────────────────────────────────────────
	/** Settings sidebar — Account section nav label and that section's page heading */
	settingsSectionAccount: "Account",
	/** Settings sidebar — Security section nav label (the page itself renders its own "auth:securityTitle" heading) */
	settingsSectionSecurity: "Security",
	/** Settings sidebar — Appearance section nav label and that section's page heading */
	settingsSectionAppearance: "Appearance",
	/** Settings sidebar — Keyboard section nav label and that section's page heading */
	settingsSectionKeyboard: "Keyboard",
	/** Settings sidebar — Events section nav label and that section's page heading */
	settingsSectionEvents: "Events",
	/** Settings sidebar — Billing section nav label and that section's page heading */
	settingsSectionBilling: "Billing",
	/** Settings sidebar — Advanced section nav label and that section's page heading */
	settingsSectionAdvanced: "Advanced",
	/** Account, Billing and Security pages — error-state title when the account query (getUserInfo) fails to load; paired with common:tryAgain */
	settingsAccountLoadError: "Couldn't load your account",

	// ── Page layout: group titles and shared row actions ──────────────────────
	/** Group titles — small uppercase labels above each panel of rows */
	settingsGroupProfile: "Profile",
	settingsGroupYourData: "Your data",
	settingsGroupGeneral: "General",
	settingsGroupSignIn: "Sign-in",
	settingsGroupRecovery: "Recovery",
	settingsGroupPlan: "Plan",
	/** Account and Security pages — the irreversible, account-wide actions */
	settingsGroupDangerZone: "Danger zone",
	/** Row button that opens a dialog to change the value the row shows (email, password); its accessible name is the specific action */
	settingsRowChangeAction: "Change…",
	/** Row button that opens a dialog to edit several fields at once */
	settingsRowEditAction: "Edit…",

	// ── Account: avatar ──────────────────────────────────────────────────────
	/** Profile header — accessible name of the avatar, which is itself the button that opens the file picker */
	settingsAvatarChangeAction: "Change picture",
	settingsAvatarUploadSuccess: "Your profile picture has been updated.",
	/** Avatar upload — rejected file type (only JPEG/PNG accepted, mirrors the file input's own `accept`) */
	settingsAvatarInvalidType: "Please choose a JPEG or PNG image.",
	/** Avatar upload — rejected file size; {{max}} is a pre-formatted byte size (e.g. "2 MB") */
	settingsAvatarTooLarge: "Images must be smaller than {{max}}.",

	// ── Account: email ───────────────────────────────────────────────────────
	settingsEmailTitle: "Email address",
	settingsEmailDescription: "The address you sign in with",
	settingsChangeEmailAction: "Change email",
	settingsChangeEmailNew: "New email",
	settingsChangeEmailConfirm: "Confirm new email",
	settingsChangeEmailPassword: "Password",
	settingsChangeEmailInvalid: "Enter a valid email address.",
	settingsChangeEmailMismatch: "The email addresses don't match.",
	/** Change-email dialog — success toast; the account query is refetched afterward so the displayed email updates */
	settingsChangeEmailSuccess: "Your email address has been changed. Please sign in again.",
	/** Change-email dialog — mirrors "auth:changePasswordPersistFailed": the mutation succeeded server-side but the local session could not be re-saved */
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
	/** Accessible name of the personal-information row's "Edit…" button */
	settingsPersonalEditAction: "Edit personal information",
	settingsPersonalFirstName: "First name",
	settingsPersonalLastName: "Last name",
	settingsPersonalCompanyName: "Company name",
	settingsPersonalVatId: "VAT ID",
	settingsPersonalStreet: "Street",
	settingsPersonalStreetNumber: "Street number",
	settingsPersonalCity: "City",
	settingsPersonalPostalCode: "Postal code",
	settingsPersonalCountry: "Country",
	/** Personal-info country select — the sentinel item that clears the field, and the trigger's own placeholder */
	settingsPersonalCountryUnset: "Not set",
	settingsPersonalSave: "Save",
	settingsPersonalSuccess: "Your personal information has been updated.",

	// ── Account: storage breakdown ───────────────────────────────────────────
	settingsStorageTitle: "Storage",
	settingsStorageFiles: "Files",
	settingsStorageVersioned: "Versioned files",
	settingsStorageFree: "Free",

	// ── Security: row-layout labels (the rest of the page's copy lives in "auth") ──
	/** Password row title; the row's button opens the "auth:changePasswordTitle" dialog */
	settingsPasswordRowTitle: "Password",
	/** Two-factor row — current state, shown beside the row's button */
	settingsTwoFactorOn: "On",
	settingsTwoFactorOff: "Off",
	/** Two-factor row button that opens the setup dialog (QR code + secret) */
	settingsTwoFactorSetUpAction: "Set up…",
	settingsTwoFactorSetUpDescription:
		"Scan this QR code with your authenticator app, or copy the secret into it, then continue to enter the code it shows.",
	/** Setup dialog button — closes it and opens the code prompt that actually enables two-factor */
	settingsTwoFactorContinue: "Continue",
	settingsMasterKeysRowTitle: "Master keys",
	/** Master-keys row button; its accessible name is "auth:exportMasterKeysAction" */
	settingsMasterKeysExportAction: "Export…",

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
	settingsThemeSystem: "System",

	// ── Appearance: icon rail order ──────────────────────────────────────────
	settingsRailTitle: "Navigation",
	settingsRailDescription:
		"Drag the icons in the bar on the far left to reorder them, or press Alt+Up/Down on a focused icon. The order is saved in this browser.",
	settingsRailReset: "Reset order",
	settingsRailResetDescription: "Put the navigation icons back in their default order",
	settingsRailResetSuccess: "Navigation order reset",

	// ── Appearance: drive sort/view memory ───────────────────────────────────
	settingsDriveMemoryTitle: "Cloud Drive organization",
	settingsDriveMemoryDescription: "Control how sort order and view mode are remembered across directories",
	settingsRememberSortPerDirectory: "Remember sort per directory",
	settingsRememberSortPerDirectoryDescription: "Keep a separate sort order for each directory, instead of one order everywhere",
	settingsResetSort: "Reset sort",
	settingsResetSortDescription: "Reset the global sort order and clear every saved per-directory override",
	settingsResetSortConfirmBody: "This resets the global sort order and clears every saved per-directory override. This cannot be undone.",
	settingsResetSortSuccess: "Sort order has been reset.",
	settingsRememberViewPerDirectory: "Remember view mode per directory",
	settingsRememberViewPerDirectoryDescription: "Keep a separate list/grid view for each directory, instead of one view everywhere",
	settingsResetView: "Reset view",
	settingsResetViewDescription: "Reset the global view mode and clear every saved per-directory override",
	settingsResetViewConfirmBody: "This resets the global view mode and clears every saved per-directory override. This cannot be undone.",
	settingsResetViewSuccess: "View mode has been reset.",

	// ── Appearance: start screen ──────────────────────────────────────────────
	settingsStartScreenTitle: "Start screen",
	settingsStartScreenDescription: "Choose which section Filen opens to when it starts",
	settingsStartScreenDrive: "Cloud Drive",
	settingsStartScreenNotes: "Notes",
	settingsStartScreenChats: "Chats",
	settingsStartScreenContacts: "Contacts",

	// ── Account: preferences (versioning / login alerts) ────────────────────
	settingsPreferencesTitle: "Preferences",
	settingsVersioningTitle: "File versioning",
	settingsVersioningDescription: "Keep previous versions of files when they're overwritten",
	settingsLoginAlertsTitle: "Login alerts",
	settingsLoginAlertsDescription: "Get an email whenever a new device signs in to your account",

	// ── Account: destructive data controls ──────────────────────────────
	settingsDeleteAllVersionsTitle: "Delete all versioned files",
	/** Delete-versions row description; {{count}} is the number of versioned files, {{size}} a pre-formatted byte size */
	settingsDeleteAllVersionsDescription: "Permanently delete {{count}} versioned file(s), freeing up {{size}}. This cannot be undone.",
	settingsDeleteAllVersionsSubmit: "Delete versioned files",
	/** {{phrase}} interpolates DELETE_ALL_VERSIONS_PHRASE (dangerPhrases.ts) */
	settingsDeleteAllVersionsConfirmBody: 'Type "{{phrase}}" below to permanently delete every versioned file. This cannot be undone.',
	settingsDeleteAllVersionsSuccess: "All versioned files have been deleted.",
	settingsDeleteAllItemsTitle: "Delete all files and directories",
	/** Delete-everything row description; {{size}} is a pre-formatted byte size */
	settingsDeleteAllItemsDescription:
		"Permanently delete every file and directory in your account ({{size}} total). This cannot be undone.",
	settingsDeleteAllItemsSubmit: "Delete everything",
	/** {{phrase}} interpolates DELETE_ALL_ITEMS_PHRASE (dangerPhrases.ts) */
	settingsDeleteAllItemsConfirmBody: 'Type "{{phrase}}" below to permanently delete every file and directory. This cannot be undone.',
	settingsDeleteAllItemsSuccess: "Everything has been deleted.",

	// ── Billing (read-only) ───────────────────────────────────────────────
	/** Tier label rule (account-plans-stack): derived from isPremium only, never a raw plan name */
	settingsBillingTierFree: "Free",
	settingsBillingTierPro: "Pro",
	settingsBillingCurrentPlanTitle: "Current plan",
	settingsBillingManageOnFilen: "Manage on filen.io",
	settingsBillingSubscriptionsTitle: "Subscriptions",
	settingsBillingSubscriptionsDescription: "Every plan contributing to your account's total storage",
	settingsBillingSubscriptionsEmptyTitle: "No subscriptions",
	settingsBillingSubscriptionsEmptyDescription: "Active subscriptions will be listed here.",
	settingsBillingInvoicesTitle: "Invoices",
	settingsBillingInvoicesDescription: "Your billing history",
	settingsBillingInvoicesEmptyTitle: "No invoices",
	settingsBillingInvoicesEmptyDescription: "Invoices will be listed here once you have a paid subscription.",
	settingsBillingColumnPlan: "Plan",
	settingsBillingColumnStorage: "Storage",
	settingsBillingColumnCost: "Cost",
	settingsBillingColumnStarted: "Started",
	settingsBillingColumnDate: "Date",
	settingsBillingColumnGateway: "Method",
	settingsBillingColumnStatus: "Status",
	settingsBillingStatusActive: "Active",
	settingsBillingStatusCancelled: "Cancelled",
	settingsBillingStatusPending: "Pending",
	settingsBillingReferralTitle: "Invite friends",
	settingsBillingReferralLinkLabel: "Your referral link",
	/** {{earned}} is a pre-formatted byte size, {{count}} the number of people referred */
	settingsBillingReferralEarned: "{{earned}} earned from {{count}} referral(s)",
	settingsBillingReferralCopy: "Copy link",
	settingsBillingReferralCopied: "Referral link copied to clipboard.",

	// ── Advanced: web transfer limits ────────────────────────────────────────
	/** Advanced group — scoped explicitly to THIS browser tab's own uploads/downloads, since the same
	 *  app also serves as the Electron desktop frontend, whose future file-sync/network-drive engine
	 *  will carry its own separate bandwidth/concurrency settings */
	settingsAdvancedTransferTitle: "Web transfer performance",
	settingsAdvancedTransferDescription:
		"Tune how many transfers this browser tab runs in parallel and how much memory they may use. The Electron desktop app's file sync and network drive have their own separate settings.",
	settingsAdvancedTransferPreset: "Transfer performance",
	settingsAdvancedPresetBatterySaver: "Battery saver",
	settingsAdvancedPresetBalanced: "Balanced",
	settingsAdvancedPresetPerformance: "Performance",
	settingsAdvancedPresetMaximum: "Maximum",
	/** Shown after a preset change — the wasm client only reads these at startup, there is no live setter */
	settingsAdvancedRestartRequired: "This takes effect the next time Filen loads in this browser tab.",

	// ── Advanced: archives ───────────────────────────────────────────────────
	/** Advanced group — compressing and extracting archives in this browser tab */
	settingsAdvancedArchiveTitle: "Archives",
	settingsAdvancedArchiveDescription: "How this browser tab compresses and extracts archives",
	/** Select row — the memory one archive job's codecs may use */
	settingsAdvancedArchiveMemory: "Archive memory",
	/** Row description; followed by settingsAdvancedRestartRequired. The tab keeps memory it grew into (wasm memory never shrinks) */
	settingsAdvancedArchiveMemoryDescription:
		"Memory one archive job may use. More allows higher compression levels and opening archives made with bigger dictionaries. Once used, this tab keeps the memory until it is closed.",
	/** Row description, after settingsAdvancedArchiveMemoryDescription; {{size}} is the largest option in mebibytes. Filen's memory in one tab is capped at 1 GiB, shared with transfers and thumbnails */
	settingsAdvancedArchiveMemoryHighHint:
		"Filen can use at most 1 GiB of memory per tab, so {{size}} MiB next to heavy transfers or thumbnails can run out. Choose it only for archives that need it.",
	/** Select option; {{size}} is a whole number of mebibytes */
	settingsAdvancedArchiveMemoryOption: "{{size}} MiB",
	/** Select option for the default value; {{size}} is a whole number of mebibytes */
	settingsAdvancedArchiveMemoryOptionDefault: "{{size}} MiB (default)",
	/** Appended to the row description while the saved value awaits the next load; {{size}} is a whole number of mebibytes */
	settingsAdvancedArchiveMemoryInEffect: "In effect now: {{size}} MiB.",

	// ── Advanced: uploads ────────────────────────────────────────────────────
	settingsAdvancedUploadsTitle: "Uploads",
	settingsAdvancedUploadsDescription: "How files are prepared before they are uploaded",
	/** Switch — re-encode HEIC/HEIF photos as JPG before upload; off by default */
	settingsConvertHeicToJpg: "Convert HEIC/HEIF to JPG",
	settingsConvertHeicToJpgDescription: "Upload HEIC and HEIF photos as JPG, so they open on devices and apps without HEIC support",

	// ── Advanced: diagnostic logs ─────────────────────────────────────────────
	settingsLogsTitle: "Diagnostic logs",
	/** {{count}} is the ring buffer's max size (500) */
	settingsLogsDescription: "The last {{count}} log entries from this browser tab, kept in memory for troubleshooting",
	settingsLogsEmpty: "No log entries yet.",
	settingsLogsRefresh: "Refresh",
	settingsLogsExport: "Export logs",
	settingsLogsExportSuccess: "Your logs have started downloading.",

	// ── Advanced: about / legal ────────────────────────────────────────────────
	settingsAboutTitle: "About",

	// ── Advanced: open source licenses ────────────────────────────────────────
	/** Advanced settings — row title for the third-party attribution surface */
	settingsNoticesTitle: "Open source licenses",
	/** Advanced settings — row description explaining what the list contains */
	settingsNoticesDescription: "Filen is built on open source software. These are the packages it includes, with their licenses.",
	/** Advanced settings — button opening the licenses dialog */
	settingsNoticesOpen: "View licenses",
	/** Licenses dialog — filter box placeholder and aria-label */
	settingsNoticesFilterPlaceholder: "Filter packages",
	/** Licenses dialog — subtitle showing how many packages are listed; singular */
	settingsNoticesCount_one: "{{count}} package",
	/** Licenses dialog — subtitle showing how many packages are listed; plural */
	settingsNoticesCount_other: "{{count}} packages",
	/** Licenses dialog — empty state when the filter matches nothing */
	settingsNoticesEmpty: "No packages match your filter.",
	/** Licenses dialog — back button returning from one package's notice to the full list */
	settingsNoticesBack: "Back to all packages",
	/** Licenses dialog — shown for a package that shipped no license file; its SPDX id and repository are listed instead of another package's copyright */
	settingsNoticesNoLicenseText: "This package did not ship a license file. Its license and repository are listed above."
} as const
