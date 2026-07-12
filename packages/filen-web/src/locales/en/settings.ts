// English source catalog — "settings" namespace: the settings sidebar (Account / Security /
// Appearance / Events / Billing sections) plus the Account and Appearance section content. The
// existing "auth" namespace keeps the Security section's copy unchanged (that page ships as-is);
// this namespace never duplicates those keys. Same typed-catalog rules as every other namespace:
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
	/** Settings sidebar — Events section nav label and that section's page heading */
	settingsSectionEvents: "Events",
	/** Settings sidebar — Billing section nav label and that section's page heading */
	settingsSectionBilling: "Billing",
	/** Account page — error-state title, mirrors "auth:securityLoadError" for its own section */
	settingsAccountLoadError: "Couldn't load your account",

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
	settingsThemeSystem: "System",

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

	// ── Account: preferences (versioning / login alerts) ────────────────────
	settingsPreferencesTitle: "Preferences",
	settingsPreferencesDescription: "Safe, reversible account settings",
	settingsVersioningTitle: "File versioning",
	settingsVersioningDescription: "Keep previous versions of files when they're overwritten",
	settingsLoginAlertsTitle: "Login alerts",
	settingsLoginAlertsDescription: "Get an email whenever a new device signs in to your account",

	// ── Account: destructive data controls ──────────────────────────────
	/** Shared across both bulk-delete TypedConfirmDialogs — the input field's label */
	settingsTypedConfirmLabel: "Confirmation phrase",
	settingsDeleteAllVersionsTitle: "Delete all versioned files",
	/** Delete-versions card description; {{count}} is the number of versioned files, {{size}} a pre-formatted byte size */
	settingsDeleteAllVersionsDescription: "Permanently delete {{count}} versioned file(s), freeing up {{size}}. This cannot be undone.",
	settingsDeleteAllVersionsSubmit: "Delete versioned files",
	/** {{phrase}} interpolates DELETE_ALL_VERSIONS_PHRASE (dangerPhrases.ts) */
	settingsDeleteAllVersionsConfirmBody: 'Type "{{phrase}}" below to permanently delete every versioned file. This cannot be undone.',
	settingsDeleteAllVersionsSuccess: "All versioned files have been deleted.",
	settingsDeleteAllItemsTitle: "Delete all files and directories",
	/** Delete-everything card description; {{size}} is a pre-formatted byte size */
	settingsDeleteAllItemsDescription:
		"Permanently delete every file and directory in your account ({{size}} total). This cannot be undone.",
	settingsDeleteAllItemsSubmit: "Delete everything",
	/** {{phrase}} interpolates DELETE_ALL_ITEMS_PHRASE (dangerPhrases.ts) */
	settingsDeleteAllItemsConfirmBody: 'Type "{{phrase}}" below to permanently delete every file and directory. This cannot be undone.',
	settingsDeleteAllItemsSuccess: "Everything has been deleted.",

	// ── Events (audit log) ────────────────────────────────────────────────────
	settingsEventsEmptyTitle: "No events yet",
	settingsEventsEmptyDescription: "Activity on your account — logins, uploads, sharing — will show up here.",
	/** {{count}} events on the first page couldn't be decrypted (undecryptable rather than genuinely empty) */
	settingsEventsUndecryptable: "{{count}} event(s) couldn't be decrypted.",
	settingsEventsLoadError: "Couldn't load your events",
	/** Event row fallback for a server event type this build doesn't recognize yet; {{type}} is the raw wasm UserEventKind tag */
	settingsEventUnknown: "Account activity ({{type}})",
	settingsEventFileUploaded: "File uploaded",
	settingsEventFileVersioned: "File versioned",
	settingsEventFileRestored: "File restored",
	settingsEventVersionedFileRestored: "Versioned file restored",
	settingsEventFileMoved: "File moved",
	settingsEventFileRenamed: "File renamed",
	settingsEventFileMetadataChanged: "File metadata changed",
	settingsEventFileTrash: "File moved to trash",
	settingsEventFileRm: "File deleted",
	settingsEventFileShared: "File shared",
	settingsEventFileLinkEdited: "File link edited",
	settingsEventDeleteFilePermanently: "File permanently deleted",
	settingsEventFolderTrash: "Directory moved to trash",
	settingsEventFolderShared: "Directory shared",
	settingsEventFolderMoved: "Directory moved",
	settingsEventFolderRenamed: "Directory renamed",
	settingsEventFolderMetadataChanged: "Directory metadata changed",
	settingsEventSubFolderCreated: "Subdirectory created",
	settingsEventBaseFolderCreated: "Directory created",
	settingsEventFolderRestored: "Directory restored",
	settingsEventFolderColorChanged: "Directory color changed",
	settingsEventDeleteFolderPermanently: "Directory permanently deleted",
	settingsEventFolderLinkEdited: "Directory link edited",
	settingsEventLogin: "Signed in",
	settingsEventFailedLogin: "Failed sign-in attempt",
	settingsEventPasswordChanged: "Password changed",
	settingsEventTwoFaEnabled: "Two-factor authentication enabled",
	settingsEventTwoFaDisabled: "Two-factor authentication disabled",
	settingsEventRequestAccountDeletion: "Account deletion requested",
	settingsEventTrashEmptied: "Trash emptied",
	settingsEventDeleteAll: "All files and directories deleted",
	settingsEventDeleteVersioned: "Versioned files deleted",
	settingsEventDeleteUnfinished: "Unfinished uploads deleted",
	settingsEventCodeRedeemed: "Code redeemed",
	settingsEventEmailChanged: "Email address changed",
	settingsEventEmailChangeAttempt: "Email change requested",
	settingsEventRemovedSharedInItems: "Removed items shared with you",
	settingsEventRemovedSharedOutItems: "Removed items you shared",
	settingsEventItemFavorite: "Favorite changed",

	// ── Event detail dialog ───────────────────────────────────────────────────
	settingsEventDetailIp: "IP address",
	settingsEventDetailUserAgent: "Device",
	settingsEventDetailName: "Name",
	settingsEventDetailOldName: "Previous name",
	settingsEventDetailReceiverEmail: "Shared with",
	settingsEventDetailSharerEmail: "Shared by",
	settingsEventDetailCode: "Code",
	settingsEventDetailEmail: "Email",
	settingsEventDetailOldEmail: "Previous email",
	settingsEventDetailNewEmail: "New email",
	settingsEventDetailCount: "Count",
	settingsEventDetailLinkUuid: "Link",
	settingsEventDetailFavorited: "Favorited",
	settingsEventDetailYes: "Yes",
	settingsEventDetailNo: "No",
	settingsEventDetailEncrypted: "Encrypted",

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
	/** {{earned}} is a pre-formatted byte size, {{count}} the number of people referred */
	settingsBillingReferralEarned: "{{earned}} earned from {{count}} referral(s)",
	settingsBillingReferralCopy: "Copy link",
	settingsBillingReferralCopied: "Referral link copied to clipboard."
} as const
