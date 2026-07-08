// English source catalog — "drive" namespace: My Drive plus the recents/favorites/trash roots —
// the toolbar, sidebar, empty states, sort/view controls, breadcrumb, and create-directory dialog.
// Same typed-catalog rules as common/errors/auth: flat `as const` object, camelCase keys, no
// literal '.' or ':' (real i18next namespaces, keySeparator/nsSeparator both ON).
//
// Consolidates the drive-listing copy that used to live in the "common" namespace (driveMyDrive,
// driveRecents/Favorites/Trash, driveNew, driveView*, driveEmpty*, driveSearch) so every listing
// string lives in one place; `moduleDrive` stays in "common" (a rail label alongside the other
// module* keys, not listing-surface copy), and the sharing/link sidebar destinations stay in
// "common" too until their own listing surface ships.
//
// Several keys below (sort menu, column headers, new-directory dialog, breadcrumb) are declared
// ahead of the components that will render them, so no literal string has to land in those
// components later. "directory" never "folder" — binding across every key here.
export const drive = {
	// ── Toolbar ──────────────────────────────────────────────────────────────
	/** Drive toolbar — button opening the new/upload menu */
	driveNew: "New",
	/** Drive toolbar — search input placeholder, scoped to the directory being viewed */
	driveSearch: "Search this directory",
	/** Drive toolbar — accessible label on the list-view toggle button */
	driveViewList: "List view",
	/** Drive toolbar — accessible label on the grid-view toggle button */
	driveViewGrid: "Grid view",

	// ── Sidebar ──────────────────────────────────────────────────────────────
	/** Drive sidebar — root item for the user's own drive */
	driveMyDrive: "My Drive",
	/** Drive sidebar — item listing recent files */
	driveRecents: "Recents",
	/** Drive sidebar — item listing favorited files and directories */
	driveFavorites: "Favorites",
	/** Drive sidebar — item for trashed files and directories */
	driveTrash: "Trash",
	/** Drive breadcrumb — root label for the items other users share with you */
	driveSharedIn: "Shared with me",
	/** Drive breadcrumb — root label for the items you share with other users */
	driveSharedOut: "Shared with others",

	// ── Empty state ──────────────────────────────────────────────────────────
	/** Drive page — empty-state title for a directory with no content */
	driveEmptyTitle: "Nothing here yet",
	/** Drive page — empty-state body under the title */
	driveEmptyBody: "Files and directories you add will appear here.",

	// ── Sort menu ────────────────────────────────────────────────────────────
	/** Drive toolbar — sort menu trigger label */
	driveSortBy: "Sort by",
	/** Drive sort menu — sort-by-name option label */
	driveSortName: "Name",
	/** Drive sort menu — sort-by-size option label */
	driveSortSize: "Size",
	/** Drive sort menu — sort-by-type option label (file MIME type; directories always group first) */
	driveSortType: "Type",
	/** Drive sort menu — sort-by-upload-date option label */
	driveSortUploadDate: "Upload date",
	/** Drive sort menu — sort-by-last-modified option label */
	driveSortLastModified: "Last modified",
	/** Drive sort menu — ascending direction label, paired with the active sort field */
	driveSortAscending: "Ascending",
	/** Drive sort menu — descending direction label, paired with the active sort field */
	driveSortDescending: "Descending",

	// ── List view column headers ────────────────────────────────────────────
	/** Drive list view — name column header */
	driveColumnName: "Name",
	/** Drive list view — size column header */
	driveColumnSize: "Size",
	/** Drive list view — type column header */
	driveColumnType: "Type",
	/** Drive list view — last-modified column header */
	driveColumnModified: "Modified",

	// ── New-directory dialog ─────────────────────────────────────────────────
	/** New-directory dialog — title */
	driveNewDirectoryTitle: "New directory",
	/** New-directory dialog — body under the title */
	driveNewDirectoryBody: "Enter a name for the new directory.",
	/** New-directory dialog — name field label */
	driveNewDirectoryLabel: "Name",
	/** New-directory dialog — name field placeholder */
	driveNewDirectoryPlaceholder: "Untitled directory",
	/** New-directory dialog — submit button label */
	driveNewDirectorySubmit: "Create",

	// ── Breadcrumb ───────────────────────────────────────────────────────────
	/** Drive breadcrumb — accessible label on the breadcrumb navigation landmark */
	driveBreadcrumbLabel: "Breadcrumb",

	// ── Listing ──────────────────────────────────────────────────────────────
	/** Drive listing — accessible name for the list/grid region (ARIA listbox) */
	driveListLabel: "Directory contents",
	/** Drive listing — title shown when a directory listing fails to load */
	driveLoadError: "Couldn't load this directory",
	/** Drive listing — item count summary shown in the toolbar when nothing is selected; singular */
	driveItemCount_one: "{{count}} item",
	/** Drive listing — item count summary shown in the toolbar when nothing is selected; plural */
	driveItemCount_other: "{{count}} items",
	/** Drive listing — selection count shown in the toolbar in place of the item count; singular */
	driveSelectionCount_one: "{{count}} selected",
	/** Drive listing — selection count shown in the toolbar in place of the item count; plural */
	driveSelectionCount_other: "{{count}} selected",
	/** Drive listing row — visually-hidden label announcing a favorited item's star indicator */
	driveFavorited: "Favorited",

	// ── Shared identity ──────────────────────────────────────────────────────
	/** Drive listing row/tile (shared-with-me surface) — muted secondary label naming who shared an item with the user; {{name}} = the sharer's email */
	driveSharedByLabel: "Shared by {{name}}",
	/** Drive listing row/tile (shared-with-others surface) — muted secondary label naming who the user shared an item with; {{name}} = the recipient's email */
	driveSharedWithLabel: "Shared with {{name}}",

	// ── Keymap commands ──────────────────────────────────────────────────────
	/** Keymap registry — description for the drive.newDirectory command */
	driveCommandNewDirectory: "New directory",
	/** Keymap registry — description for the drive.selectAll command */
	driveCommandSelectAll: "Select all",
	/** Keymap registry — description for the drive.clearSelection command */
	driveCommandClearSelection: "Clear selection",
	/** Keymap registry — description for the drive.toggleView command */
	driveCommandToggleView: "Toggle view",
	/** Keymap registry — description for the drive.rename command */
	driveCommandRename: "Rename",
	/** Keymap registry — description for the drive.trash command */
	driveCommandTrash: "Trash",

	// ── Item action menu ─────────────────────────────────────────────────────
	/** Item menu — accessible label for the ⋯ button opening the per-item action menu */
	driveItemMenuTrigger: "More actions",
	//
	// Per-item and bulk-selection context-menu entries. Imperative verbs (menu actions), not
	// descriptions of state — see driveActionFavorite/driveActionUnfavorite in particular.
	/** Item menu — rename the selected item; opens the rename dialog */
	driveActionRename: "Rename",
	/** Item menu — move the selected item(s); opens the destination picker (driveMoveDialogTitle) */
	driveActionMove: "Move",
	/** Item menu — move the selected item(s) to the trash; also the trash-confirm dialog's confirm button */
	driveActionTrash: "Trash",
	/** Item menu — restore the selected item(s) out of the trash; also the bulk-restore confirm dialog's confirm button */
	driveActionRestore: "Restore",
	/** Item menu (trash view) — permanently delete the selected item(s); also the delete-confirm dialog's confirm button */
	driveActionDeletePermanently: "Delete permanently",
	/** Item menu — add the selected item(s) to favorites */
	driveActionFavorite: "Favorite",
	/** Item menu — remove the selected item(s) from favorites */
	driveActionUnfavorite: "Unfavorite",
	/** Item menu — open the directory-color swatch dialog (directories only) */
	driveActionColor: "Color",
	/** Item menu — open the file-version history panel (files only) */
	driveActionVersions: "Versions",
	/** Item menu — open the info panel for the selected item */
	driveActionInfo: "Info",
	/** Item menu — open the public-link dialog for the selected item */
	driveActionPublicLink: "Public link",
	/** Item menu — copy the selected item's existing public-link URL to the clipboard */
	driveActionCopyLink: "Copy link",
	/** Trash toolbar — permanently delete every item currently in the trash; also the empty-trash confirm dialog's confirm button */
	driveActionEmptyTrash: "Empty trash",

	// ── Rename dialog ────────────────────────────────────────────────────────
	/** Rename dialog — body under the title (driveActionRename doubles as both the dialog title and its submit button, matching the new-directory dialog's own title/submit pairing) */
	driveRenameDialogBody: "Enter a new name.",

	// ── Trash confirm ────────────────────────────────────────────────────────
	/** Trash confirm dialog — title; the confirm button reuses driveActionTrash */
	driveTrashConfirmTitle: "Move to trash?",
	/** Trash confirm dialog — body for a single item */
	driveTrashConfirmBody_one: "Are you sure you want to move this item to the trash? You can restore it later.",
	/** Trash confirm dialog — body for multiple items; {{count}} = items being trashed */
	driveTrashConfirmBody_other: "Are you sure you want to move these {{count}} items to the trash? You can restore them later.",

	// ── Permanent-delete confirm ─────────────────────────────────────────────
	/** Delete-permanently confirm dialog — title; the confirm button reuses driveActionDeletePermanently */
	driveDeletePermanentlyConfirmTitle: "Delete permanently?",
	/** Delete-permanently confirm dialog — body for a single item */
	driveDeletePermanentlyConfirmBody_one: "Are you sure you want to permanently delete this item? This cannot be undone.",
	/** Delete-permanently confirm dialog — body for multiple items; {{count}} = items being deleted */
	driveDeletePermanentlyConfirmBody_other: "Are you sure you want to permanently delete these {{count}} items? This cannot be undone.",

	// ── Empty-trash confirm (typed) ──────────────────────────────────────────
	/** Empty-trash confirm dialog — title; the confirm button reuses driveActionEmptyTrash */
	driveEmptyTrashConfirmTitle: "Empty trash?",
	/** Empty-trash confirm dialog — body instructing the user to type the confirmation phrase; {{phrase}} interpolates driveEmptyTrashTypedConfirmPhrase */
	driveEmptyTrashConfirmBody: 'Type "{{phrase}}" below to permanently delete everything in the trash. This cannot be undone.',
	/** Empty-trash confirm dialog — label for the confirmation-phrase input */
	driveEmptyTrashTypedConfirmLabel: "Confirmation phrase",
	/** Empty-trash confirm dialog — the phrase the user must type EXACTLY (character for character, including case) to confirm; translate as a short, natural phrase a user can type in your language — it is compared verbatim against what they type */
	driveEmptyTrashTypedConfirmPhrase: "EMPTY TRASH",

	// ── Bulk-restore confirm ─────────────────────────────────────────────────
	/** Bulk-restore confirm dialog — title; the confirm button reuses driveActionRestore. A single restored item needs no confirm (mobile parity) — this dialog is bulk-selection only */
	driveRestoreSelectedConfirmTitle: "Restore items?",
	/** Bulk-restore confirm dialog — body for a single selected item */
	driveRestoreSelectedConfirmBody_one: "Are you sure you want to restore this item?",
	/** Bulk-restore confirm dialog — body for multiple selected items; {{count}} = items being restored */
	driveRestoreSelectedConfirmBody_other: "Are you sure you want to restore these {{count}} items?",

	// ── Move dialog ──────────────────────────────────────────────────────────
	/** Move dialog — title of the destination-directory picker */
	driveMoveDialogTitle: "Select destination",
	/** Move dialog — confirm button moving the selection into the currently open directory */
	driveMoveHereAction: "Move here",

	// ── Color dialog ─────────────────────────────────────────────────────────
	/** Color dialog — title (opened via driveActionColor) */
	driveColorDialogTitle: "Directory color",

	// ── Directory colors ─────────────────────────────────────────────────────
	// Swatch names shown in the color dialog (driveColorDialogTitle) and as each swatch's accessible label.
	/** Directory color swatch — the default (uncolored) state */
	driveColorDefault: "Default",
	/** Directory color swatch */
	driveColorBlue: "Blue",
	/** Directory color swatch */
	driveColorGreen: "Green",
	/** Directory color swatch */
	driveColorPurple: "Purple",
	/** Directory color swatch */
	driveColorRed: "Red",
	/** Directory color swatch */
	driveColorGray: "Gray",

	// ── Versions panel ───────────────────────────────────────────────────────
	/** Versions panel — heading (opened via driveActionVersions) */
	driveVersionsPanelTitle: "Versions",
	/** Versions panel — empty state when a file has no earlier versions */
	driveVersionsEmpty: "No previous versions",
	/** Versions panel — badge marking the file's current (live) version among its history */
	driveVersionsCurrentBadge: "Current",
	/** Versions panel — per-row action restoring that specific version's content (rotates the file's uuid) */
	driveVersionsRestoreAction: "Restore this version",
	/** Versions panel — per-row action permanently deleting that specific version */
	driveVersionsDeleteAction: "Delete this version",

	// ── Version restore confirm ──────────────────────────────────────────────
	/** Version restore confirm dialog — title; restoring rotates the file onto this version's uuid, replacing its current live content (mobile parity: restore confirms too, not just delete) */
	driveVersionsRestoreConfirmTitle: "Restore this version?",
	/** Version restore confirm dialog — body; the confirm button reuses driveVersionsRestoreAction */
	driveVersionsRestoreConfirmBody: "Are you sure you want to restore this version? It will replace the file's current content.",

	// ── Version delete confirm ───────────────────────────────────────────────
	/** Version delete confirm dialog — title; deleting a single version is permanent, unlike trashing an item */
	driveVersionsDeleteConfirmTitle: "Delete this version?",
	/** Version delete confirm dialog — body; the confirm button reuses driveVersionsDeleteAction */
	driveVersionsDeleteConfirmBody: "Are you sure you want to permanently delete this version? This cannot be undone.",

	// ── Version delete guard ─────────────────────────────────────────────────
	/** File-versions defense-in-depth guard — surfaced only if a caller reaches the delete-version action helper directly on the file's own live version (its uuid IS the file's current content, so deleting it would destroy the file, not just history); the panel's own per-row disabled state already keeps the UI from reaching this, so this message is a last-resort backstop */
	driveVersionsDeleteLiveBlocked: "This is the current version and can't be deleted.",

	// ── Info panel ───────────────────────────────────────────────────────────
	/** Info panel — heading (opened via driveActionInfo) */
	driveInfoPanelTitle: "Info",
	/** Info panel — row label: the item's directory path (breadcrumb ancestors) */
	driveInfoPath: "Location",
	/** Info panel — row label: size on disk (a directory's is the recursive aggregate) */
	driveInfoSize: "Size",
	/** Info panel — row label: number of files inside a directory */
	driveInfoFileCount: "Files",
	/** Info panel — row label: number of sub-directories inside a directory */
	driveInfoDirectoryCount: "Directories",
	/** Info panel — row label: creation date */
	driveInfoCreated: "Created",
	/** Info panel — row label: last-modified date */
	driveInfoModified: "Modified",
	/** Info panel — row label: MIME type of a file */
	driveInfoMimeType: "MIME type",

	// ── Public link dialog ───────────────────────────────────────────────────
	/** Public-link dialog — title (opened via driveActionPublicLink) */
	driveLinkDialogTitle: "Public link",
	/** Public-link dialog — button creating a new public link for an item that doesn't have one yet */
	driveLinkEnableAction: "Create public link",
	/** Public-link dialog — button disabling and removing the item's existing public link */
	driveLinkDisableAction: "Disable public link",
	/** Public-link dialog — label for the optional password field protecting the link */
	driveLinkPasswordLabel: "Password",
	/** Public-link dialog — placeholder for the password field when the link has no password set */
	driveLinkPasswordPlaceholder: "No password",
	/** Public-link dialog — label for the link-expiration field */
	driveLinkExpirationLabel: "Expires",
	/** Public-link dialog — label for the toggle allowing downloads through the link */
	driveLinkDownloadableLabel: "Allow downloads",
	/** Public-link dialog — label for the link-URL field shown next to the copy button */
	driveLinkUrlLabel: "Link",
	/** Public-link dialog — empty-state title shown before a link has been created for this item */
	driveLinkNoLinkTitle: "No public link",
	/** Public-link dialog — empty-state description under driveLinkNoLinkTitle */
	driveLinkNoLinkDescription: "Anyone with the link can access this item.",
	/** Public-link dialog — toast shown after the link URL is copied to the clipboard */
	driveLinkUrlCopiedToast: "Link copied to clipboard",
	/** Public-link dialog — status text shown next to the password field when a password is already set (the field itself never shows the plaintext) */
	driveLinkPasswordSetStatus: "Password set",
	/** Public-link dialog — button revealing the password field to set the link's first password */
	driveLinkPasswordSetAction: "Set password",
	/** Public-link dialog — button revealing the password field to replace an already-set password */
	driveLinkPasswordChangeAction: "Change password",
	/** Public-link dialog — button removing the link's password entirely */
	driveLinkPasswordRemoveAction: "Remove password",
	/** Public-link dialog — button confirming a typed password while the password field is open */
	driveLinkPasswordSaveAction: "Save",
	/** Public-link dialog — progress text shown while a directory link is being created; {{percent}} = 0-100 */
	driveLinkCreatingProgress: "Encrypting… {{percent}}%",
	/** Public-link dialog — expiration option: the link never expires */
	driveLinkExpirationNever: "Never",
	/** Public-link dialog — expiration option: 1 hour */
	driveLinkExpirationOneHour: "1 hour",
	/** Public-link dialog — expiration option: 6 hours */
	driveLinkExpirationSixHours: "6 hours",
	/** Public-link dialog — expiration option: 1 day */
	driveLinkExpirationOneDay: "1 day",
	/** Public-link dialog — expiration option: 3 days */
	driveLinkExpirationThreeDays: "3 days",
	/** Public-link dialog — expiration option: 1 week */
	driveLinkExpirationOneWeek: "1 week",
	/** Public-link dialog — expiration option: 2 weeks */
	driveLinkExpirationTwoWeeks: "2 weeks",
	/** Public-link dialog — expiration option: 30 days */
	driveLinkExpirationThirtyDays: "30 days",

	// ── Bulk action result toast ─────────────────────────────────────────────
	// Partial-success summary (web departs from mobile's fail-fast bulk ops here): every selected item
	// runs independently, so a bulk trash/restore/favorite/color/delete can partially fail without
	// aborting the rest. Generic across every bulk action rather than one pair per action.
	/** Bulk action result toast — every selected item succeeded; {{count}} = items affected */
	driveBulkActionComplete_one: "{{count}} item updated",
	/** Bulk action result toast — every selected item succeeded (plural); {{count}} = items affected */
	driveBulkActionComplete_other: "{{count}} items updated",
	/** Bulk action result toast — at least one selected item failed; {{count}} = items that succeeded, {{failed}} = items that failed */
	driveBulkActionCompleteWithFailures_one: "{{count}} item updated, {{failed}} failed",
	/** Bulk action result toast — at least one selected item failed (plural); {{count}} = items that succeeded, {{failed}} = items that failed */
	driveBulkActionCompleteWithFailures_other: "{{count}} items updated, {{failed}} failed"
} as const
