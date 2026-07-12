// English source catalog — "common" namespace: the minimal boot/theme vocabulary needed so far;
// feature catalogs land per-area as they ship, mirroring filen-mobile's per-area-file convention.
// Flat `as const` object: i18next's default `keySeparator` ('.') and `nsSeparator` (':') stay ON
// here (unlike mobile, which disables both to run one flat namespace) — this app declares real
// namespaces ("common", "errors", "auth"), so keys must avoid literal '.' or ':' characters.
export const common = {
	/** Product name — rendered beside the logo on the boot screen and as the icon rail's accessible home label; brand, never translated */
	appName: "Filen",
	/** Boot screen — status line under the logo while the app downloads and starts the SDK */
	bootDownloading: "Downloading Filen…",
	/** Boot failure screen — title shown when the app could not start */
	bootErrorTitle: "Filen could not start",
	/** Shared reload-page action label: boot failure screen button, /no-coi and /no-opfs page buttons, and the update toast's action */
	reload: "Reload page",
	/** Dialog primitive (ui/dialog.tsx) — screen-reader label on the icon-only close button, and the text label on the optional footer close button */
	close: "Close",
	/** Generic dialog cancel button — shared by every ConfirmDialog/TypedConfirmDialog consumer (e.g. the reset page's skip-master-keys ceremony) */
	cancel: "Cancel",
	/** Generic retry button for a failed data load (e.g. the security settings page's account query) — shared by any future error-state view */
	tryAgain: "Try again",
	/** /no-coi error page — title shown when the page loaded without the required cross-origin isolation */
	noCoiTitle: "Unable to start Filen securely",
	/** /no-coi error page — body explaining the missing isolation and suggesting a reload */
	noCoiBody:
		"Your browser did not load this page with the isolation features Filen requires. Try reloading the page, or contact support if the problem continues.",
	/** /no-opfs error page — title shown when the browser could not provide the persistent storage Filen requires */
	noOpfsTitle: "Persistent storage is unavailable",
	/** /no-opfs error page — body explaining OPFS is required and suggesting how to fix it (enable it, use a supported browser) */
	noOpfsBody:
		"Filen needs your browser's private, persistent file storage (OPFS) to keep your data on this device. It may be disabled or blocked in a private/incognito window. Enable it, or switch to a recent version of Chrome, Edge, or Safari, then reload the page.",
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
	/** Chats module — icon rail accessible label when there are unread messages (singular) */
	chatsUnreadBadge_one: "Chats, {{count}} unread message",
	/** Chats module — icon rail accessible label when there are unread messages (plural) */
	chatsUnreadBadge_other: "Chats, {{count}} unread messages",
	/** Contacts module — icon rail tooltip/accessible label (not available yet) */
	moduleContacts: "Contacts",
	/** Contacts module — icon rail accessible label when there are pending incoming requests (singular) */
	contactRequestsBadge_one: "Contacts, {{count}} pending request",
	/** Contacts module — icon rail accessible label when there are pending incoming requests (plural) */
	contactRequestsBadge_other: "Contacts, {{count}} pending requests",
	/** Transfers module — icon rail tooltip/accessible label (not available yet) */
	moduleTransfers: "Transfers",
	// Account menu
	/** Account menu — trigger's accessible label and the dropdown's heading */
	account: "Account",
	/** Icon rail — settings item tooltip/accessible label; opens the settings page (security: change password, two-factor authentication, master-keys export, delete account) */
	settings: "Settings",
	/** Account menu — item that signs the user out; the sign-out confirm dialog reuses it as its confirm button */
	signOut: "Sign out",
	/** Icon rail — tooltip + accessible label on the storage-usage meter */
	storage: "Storage",
	/** Drive sidebar — storage meter caption; {{used}} and {{total}} are pre-formatted byte sizes (e.g. "1.2 GB of 100 GB used") */
	storageUsage: "{{used}} of {{total}} used",
	/** Icon rail — help entry tooltip/accessible label (its destination ships later) */
	help: "Help",
	/** Drive sidebar — heading of the bottom usage block (above the storage meter) */
	usage: "Usage",
	// Drive sidebar — sharing and public-link destinations; kept here (not in the "drive" namespace,
	// which holds the rest of the listing surface) until their own listing surface ships.
	/** Drive sidebar — item for content other users shared with the user */
	driveSharedIn: "Shared with me",
	/** Drive sidebar — item for content the user shared with others */
	driveSharedOut: "Shared with others",
	/** Drive sidebar — item for the user's public links */
	driveLinks: "Links",
	// Global offline indicator — a fixed, non-blocking pill mounted once at the app root so it covers
	// every route (authed shell and the unauthenticated sign-in/register/reset pages alike)
	/** Offline indicator — shown while the browser has no connection */
	offline: "Offline",
	/** Offline indicator — transient confirmation shown for a few seconds after connectivity returns */
	backOnline: "Back online",
	/** Disabled-control tooltip/title suffix — appended wherever a mutating action is disabled purely because the app is offline */
	offlineActionDisabled: "Unavailable while offline",
	// Desktop system strip — win32/linux custom window controls (darwin uses native traffic lights,
	// no custom buttons); only rendered when window.desktop is present (see src/types/desktop.d.ts)
	/** System strip — minimize-window button accessible label */
	windowMinimize: "Minimize",
	/** System strip — maximize-window button accessible label, shown while the window is not maximized */
	windowMaximize: "Maximize",
	/** System strip — restore-window button accessible label, shown while the window is maximized */
	windowRestore: "Restore",
	/** System strip — hide-window button accessible label */
	windowHide: "Hide",
	/** System strip — close-window button accessible label */
	windowClose: "Close window",
	// Undecryptable-item explainer — shown in place of the normal content wherever an item whose
	// metadata never decrypted can still be reached (note editor pane, drive info dialog)
	/** Cannot-decrypt explainer — heading */
	cannotDecryptTitle: "Cannot decrypt",
	/** Cannot-decrypt explainer — reason line */
	cannotDecryptBody: "This item could not be decrypted. It may have been created with a different account or key.",
	// Service worker update prompt
	/** Update toast — title raised when a new version has been installed and is waiting */
	updateReadyTitle: "Update ready",
	/** Update toast — body; the toast's action button reloads the page to apply the update */
	updateReadyBody: "A new version of Filen has been downloaded. Reload to use it."
} as const
