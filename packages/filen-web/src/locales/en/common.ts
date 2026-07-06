// English source catalog — "common" namespace: the minimal boot/theme vocabulary needed so far;
// feature catalogs land per-area as they ship, mirroring filen-mobile's per-area-file convention.
// Flat `as const` object: i18next's default `keySeparator` ('.') and `nsSeparator` (':') stay ON
// here (unlike mobile, which disables both to run one flat namespace) — this app declares real
// namespaces ("common", "errors", "auth"), so keys must avoid literal '.' or ':' characters.
export const common = {
	/** Product name — rendered beside the logo on the boot screen and as the icon rail's accessible home label; brand, never translated */
	appName: "Filen",
	/** Icon rail — tooltip + accessible label on the warning badge shown when storage runs in-memory (nothing persists after reload) */
	ephemeralSession: "Ephemeral session",
	/** Boot screen — status line under the logo while the app downloads and starts the SDK */
	bootDownloading: "Downloading Filen…",
	/** Boot failure screen — title shown when the app could not start */
	bootErrorTitle: "Filen could not start",
	/** Shared reload-page action label: boot failure screen button, /no-coi page button, and the update toast's action */
	reload: "Reload page",
	/** /no-coi error page — title shown when the page loaded without the required cross-origin isolation */
	noCoiTitle: "Unable to start Filen securely",
	/** /no-coi error page — body explaining the missing isolation and suggesting a reload */
	noCoiBody:
		"Your browser did not load this page with the isolation features Filen requires. Try reloading the page, or contact support if the problem continues.",
	/** Theme toggle — icon rail button tooltip/accessible label and the keymap action description shown in shortcut UI */
	toggleTheme: "Toggle theme",
	/** Icon rail — tooltip suffix on modules and items that are not available yet */
	comingSoon: "Coming soon",
	// Rail modules
	/** Drive module — icon rail tooltip/accessible label and the drive page heading */
	moduleDrive: "Cloud Drive",
	/** Notes module — icon rail tooltip/accessible label (not available yet) */
	moduleNotes: "Notes",
	/** Chats module — icon rail tooltip/accessible label (not available yet) */
	moduleChats: "Chats",
	/** Contacts module — icon rail tooltip/accessible label (not available yet) */
	moduleContacts: "Contacts",
	/** Transfers module — icon rail tooltip/accessible label (not available yet) */
	moduleTransfers: "Transfers",
	// Account menu
	/** Account menu — trigger's accessible label and the dropdown's heading */
	account: "Account",
	/** Icon rail — settings item tooltip/accessible label (not available yet) */
	settings: "Settings",
	/** Account menu — item that signs the user out; the sign-out confirm dialog reuses it as its confirm button */
	signOut: "Sign out",
	/** Icon rail — tooltip + accessible label on the storage-usage meter */
	storage: "Storage",
	// Drive
	/** Drive toolbar — button opening the new/upload menu */
	driveNew: "New",
	/** Drive toolbar — search input placeholder, scoped to the directory being viewed */
	driveSearch: "Search this directory",
	/** Drive toolbar — accessible label on the list-view toggle button */
	driveViewList: "List view",
	/** Drive toolbar — accessible label on the grid-view toggle button */
	driveViewGrid: "Grid view",
	/** Drive sidebar — root item for the user's own drive */
	driveMyDrive: "My Drive",
	/** Drive sidebar — item listing recent files */
	driveRecents: "Recents",
	/** Drive sidebar — item listing favorited files and directories */
	driveFavorites: "Favorites",
	/** Drive sidebar — item for trashed files and directories */
	driveTrash: "Trash",
	/** Drive sidebar — item for content other users shared with the user */
	driveSharedIn: "Shared with me",
	/** Drive sidebar — item for content the user shared with others */
	driveSharedOut: "Shared with others",
	/** Drive sidebar — item for the user's public links */
	driveLinks: "Links",
	/** Drive page — empty-state title for a directory with no content */
	driveEmptyTitle: "Nothing here yet",
	/** Drive page — empty-state body under the title */
	driveEmptyBody: "Files and directories you add will appear here.",
	// Service worker update prompt
	/** Update toast — title raised when a new version has been installed and is waiting */
	updateReadyTitle: "Update ready",
	/** Update toast — body; the toast's action button reloads the page to apply the update */
	updateReadyBody: "A new version of Filen has been downloaded. Reload to use it."
} as const
