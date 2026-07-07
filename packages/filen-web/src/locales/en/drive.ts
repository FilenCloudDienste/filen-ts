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
	driveFavorited: "Favorited"
} as const
