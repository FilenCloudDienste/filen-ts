// English source catalog — "common" namespace: the minimal boot/theme vocabulary needed so far;
// feature catalogs land per-area as they ship, mirroring filen-mobile's per-area-file convention.
// Flat `as const` object: i18next's default `keySeparator` ('.') and `nsSeparator` (':') stay ON
// here (unlike mobile, which disables both to run one flat namespace) — this app declares TWO real
// namespaces ("common", "errors"), so keys must avoid literal '.' or ':' characters.
export const common = {
	appName: "Filen",
	loading: "Loading…",
	ephemeralSession: "Ephemeral session",
	bootDownloading: "Downloading Filen…",
	bootErrorTitle: "Filen could not start",
	retry: "Try again",
	reload: "Reload page",
	noCoiTitle: "Unable to start Filen securely",
	noCoiBody:
		"Your browser did not load this page with the isolation features Filen requires. Try reloading the page, or contact support if the problem continues.",
	toggleTheme: "Toggle theme",
	comingSoon: "Coming soon",
	// Rail modules
	moduleDrive: "Cloud Drive",
	moduleNotes: "Notes",
	moduleChats: "Chats",
	moduleContacts: "Contacts",
	moduleTransfers: "Transfers",
	// Account menu
	account: "Account",
	settings: "Settings",
	signOut: "Sign out",
	storage: "Storage",
	// Drive
	driveNew: "New",
	driveSearch: "Search this directory",
	driveViewList: "List view",
	driveViewGrid: "Grid view",
	driveMyDrive: "My Drive",
	driveRecents: "Recents",
	driveFavorites: "Favorites",
	driveTrash: "Trash",
	driveSharedIn: "Shared with me",
	driveSharedOut: "Shared with others",
	driveLinks: "Links",
	driveEmptyTitle: "Nothing here yet",
	driveEmptyBody: "Files and directories you add will appear here.",
	// Login (placeholder — the real sign-in flow lands next)
	loginTitle: "Sign in to Filen",
	loginSubtitle: "Your end-to-end encrypted drive, notes and chats.",
	loginEmail: "Email",
	loginPassword: "Password",
	loginContinue: "Continue",
	loginPlaceholderNote: "Sign-in arrives in the next update."
} as const
