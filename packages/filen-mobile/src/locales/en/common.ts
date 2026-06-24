// Truly-shared vocabulary — keys reused across multiple features. Feature catalogs
// (appearance.ts, transfers.ts, …) must NOT redefine any key declared here; the barrel
// (src/locales/en/index.ts) merges all area objects into one flat namespace and every key
// must be globally unique.
//
// Format: a flat (no nesting) `as const` object of snake_case keys → English copy, with one
// `/** JSDoc */` per key giving translator context. Comments strip at build; the `as const`
// gives full key-type-safety (see src/i18next.d.ts). i18next runs with `keySeparator:false`
// and `nsSeparator:false`, so keys are treated as opaque flat literals (dots/colons in a key
// are literal characters, not path separators).
//
// PLURAL/CONTEXT SEPARATOR RULE (Risk 1): `keySeparator:false` does NOT disable i18next's
// `pluralSeparator`/`contextSeparator`, both of which default to `_`. Because these keys are
// snake_case, a pluralized key (i18next appends `_one`/`_other`/`_male`/…) collides with the
// snake_case convention: the base key must NOT itself end in a plural/context suffix token.
// A plural key is declared as a `<base>_one`/`<base>_other` pair and called as `t("<base>", { count })`;
// no NON-plural key may end in `_one`/`_other`/`_zero`/`_two`/`_few`/`_many`/`_male`/`_female`.
// If a future base key legitimately needs such a suffix, override `pluralSeparator`/
// `contextSeparator` to a snake-safe value (e.g. `"__"`) in src/lib/i18n.ts.
//
// Native language names (English, Deutsch, …) do NOT live here — they are non-translated
// constants in src/lib/language.ts.
export const common = {
	// ── Generic dialog / form buttons ─────────────────────────────────────────
	/** Generic confirm/destructive action button: reset */
	reset: "Reset",
	/** Generic dialog cancel button */
	cancel: "Cancel",
	/** Generic dialog submit / confirm button */
	submit: "Submit",
	/** Generic action-sheet / dialog dismiss button */
	close: "Close",
	/** Generic affirmative confirmation button */
	ok: "OK",
	/** Generic affirmative answer button (yes/no prompts) */
	yes: "Yes",
	/** Generic negative answer button (yes/no prompts) */
	no: "No",
	/** Generic button advancing a multi-step flow to the next step */
	next: "Next",
	/** Generic button to proceed past a confirmation or informational prompt */
	continue: "Continue",
	/** Generic button to navigate back to the previous screen (e.g. from a dead-end empty state) */
	go_back: "Go back",
	/** Generic button to postpone / defer an action (e.g. a reminder) */
	later: "Later",
	/** Generic button to clear / dismiss an error or input */
	clear: "Clear",
	/** Generic title for an error banner / error dialog */
	error: "Error",

	// ── Generic credentials / form fields ─────────────────────────────────────
	/** Generic email field label / placeholder (login + registration forms, reset prompts) */
	email: "Email",
	/** Generic password field label / placeholder */
	password: "Password",
	/** Generic login action: login submit button, 2FA confirm, "already have an account" link */
	sign_in: "Login",
	/** Generic logout action */
	logout: "Logout",
	/** Generic placeholder hint for an email input, shown as faded example text */
	email_placeholder_hint: "you@example.com",
	/** Generic validation error shown when an entered email address is not valid */
	please_enter_valid_email: "Please enter a valid email address.",
	/** Generic label for a name field / a displayed item's name */
	name: "Name",

	// ── Generic item actions (menus, toolbars, swipe actions) ─────────────────
	/** Generic action: create a new item */
	create: "Create",
	/** Generic action: add an item */
	add: "Add",
	/** Generic action: open an item */
	open: "Open",
	/** Generic action: view an item / its details */
	view: "View",
	/** Generic action: edit an item */
	edit: "Edit",
	/** Generic action: rename an item */
	rename: "Rename",
	/** Generic action: save changes */
	save: "Save",
	/** Generic destructive action: discard unsaved changes */
	discard: "Discard changes",
	/** Generic action: duplicate an item */
	duplicate: "Duplicate",
	/** Generic action: move an item to another location */
	move: "Move",
	/** Generic action: share an item */
	share: "Share",
	/** Generic action: download an item to the device */
	download: "Download",
	/** Generic action: upload one or more items */
	upload: "Upload",
	/** Generic action: import an item / content */
	import: "Import",
	/** Generic action: export an item / content */
	export: "Export",
	/** Generic action: copy a value to the clipboard */
	copy: "Copy",
	/** Generic action: remove an item from a collection (non-destructive) */
	remove: "Remove",
	/** Generic destructive action: permanently delete an item */
	delete: "Delete",
	/** Generic action: move an item to the trash */
	trash: "Trash",
	/** Generic action: restore an item (from trash / history / a previous version) */
	restore: "Restore",
	/** Generic action: archive an item */
	archive: "Archive",
	/** Generic action: open an item's info / details panel */
	info: "Info",
	/** Generic action: open settings */
	settings: "Settings",
	/** Generic action: leave a shared item (chat, note, share) */
	leave: "Leave",

	// ── Generic toggle-state actions ──────────────────────────────────────────
	/** Generic action: mark an item as a favorite */
	favorite: "Favorite",
	/** Generic action: remove an item from favorites */
	unfavorite: "Unfavorite",
	/** Generic action: pin an item to the top of a list */
	pin: "Pin",
	/** Generic action: unpin a pinned item */
	unpin: "Unpin",
	/** Generic action: mark an item / conversation as read */
	mark_as_read: "Mark as read",
	/** Generic action: enable a feature / setting */
	enable: "Enable",
	/** Generic action: disable a feature / setting */
	disable: "Disable",
	/** Generic state label: a feature / setting is enabled */
	enabled: "Enabled",

	// ── Selection mode (multi-select toolbars across drive/notes/chats/contacts/playlists/photos) ──
	/** Selection-mode action: enter selection / select an item */
	select: "Select",
	/** Selection-mode action: deselect a selected item */
	deselect: "Deselect",
	/** Selection-mode action: select every item in the list */
	select_all: "Select all",
	/** Selection-mode action: clear the entire selection */
	deselect_all: "Deselect all",
	/** Selection-mode header count (singular). Reused as the title while one item is selected. {{count}} is the count */
	selected_one: "{{count}} selected",
	/** Selection-mode header count (plural). Reused as the title while multiple items are selected. {{count}} is the count */
	selected_other: "{{count}} selected",
	/** Selection-mode bulk action: delete every selected item */
	delete_selected: "Delete selected",
	/** Generic confirm button: delete every item in a collection at once */
	delete_all: "Delete all",
	/** Selection-mode bulk action: restore every selected item (from trash / archive) */
	restore_selected: "Restore selected",
	/** Selection-mode bulk action: move every selected item to the trash */
	trash_selected: "Trash selected",
	/** Selection-mode bulk action: download every selected item to the device */
	download_selected: "Download selected",
	/** Selection-mode bulk action: make every selected item available offline */
	make_available_offline_selected: "Make available offline",
	/** Error when a selected item's parent directory can't be resolved for offline storage */
	offline_location_unavailable: "Couldn't determine the location of a selected item. Open its directory once, then try again.",
	/** Selection-mode bulk action: mark every selected item as a favorite */
	favorite_selected: "Favorite selected",
	/** Selection-mode bulk action: remove every selected item from favorites */
	unfavorite_selected: "Unfavorite selected",
	/** Selection-mode bulk action: remove every selected participant (chat / note) */
	remove_selected: "Remove selected",

	// ── Generic input / confirmation copy ─────────────────────────────────────
	/** Generic input-dialog message asking for a new name (rename flows) */
	enter_new_name: "Enter a new name",
	/** Generic inline error shown when two password fields do not match */
	passwords_do_not_match: "Passwords do not match",
	/** Generic dialog title shown when an item / link is password protected */
	password_required: "Password required",
	/** Generic confirmation dialog title before removing a single participant (chat / note) */
	remove_participant: "Remove participant",
	/** Generic camera action: take a new photo or video (upload / attach flows) */
	take_photo_or_video: "Take photo or video",
	/** Generic duration option: one hour (expiry / lock timeout pickers) */
	one_hour: "1 hour",

	// ── External links (chat messages, file/text previews) ────────────────────
	/** Confirmation dialog title shown before opening a link to an external website */
	open_external_link: "Open external link",
	/** Confirmation dialog message shown before opening an external link. {{domain}} is the target domain */
	open_external_link_message: "Do you want to open {{domain}}?",
	/** Confirm button that opens (and trusts) the external link */
	open_trust: "Open & trust",
	/** Error toast shown when an external link cannot be opened */
	cannot_open_link: "Could not open link",

	// ── Decryption / permissions / unknown fallbacks (cross-feature) ──────────
	/** Toast shown when an item's contents could not be decrypted */
	cannot_decrypt_toast: "Could not decrypt this item",
	/** Error toast shown when a required permission was denied; tells the user to enable it in system settings */
	no_permissions_enable_manually: "Permission denied. Please enable it manually in your device settings.",
	/** Generic placeholder for an unknown / unavailable value (e.g. an unknown sender or contact) */
	unknown: "Unknown",
	/** Toast confirming a value was copied to the clipboard */
	copied_to_clipboard: "Copied to clipboard",

	// ── Shared nouns / metadata labels ────────────────────────────────────────
	/** Generic noun: a file */
	file: "File",
	/** Generic noun: a directory (Filen uses "directory", never "folder") */
	directory: "Directory",
	/** Generic metadata label: an item's type (file type / note type / event type) */
	type: "Type",
	/** Generic metadata label: an item's history / version history */
	history: "History",
	/** Generic label for an item's participants (chat / note collaborators) */
	participants: "Participants",
	/** Metadata row on a list item shared WITH the current user — names the owner who shared it */
	shared_by_email: "Shared by {{email}}",
	/** Mention placeholder addressing every participant in a conversation */
	everyone: "Everyone",

	// ── Generic error / empty-state subtitles (ListEmpty) ─────────────────────
	/** Generic error-state subtitle: prompts a connectivity check + retry (shown under "Couldn't load …" empty states) */
	please_check_connection: "Please check your connection and try again.",
	/** Generic empty-state title shown when a search/filter returns no matching items */
	no_results: "No results",
	/** Generic empty-state subtitle under no_results, hinting to adjust the search */
	no_results_description: "Try a different search.",

	// ── Relative time (formatRelativeTime — falls back to a full date after 7 days) ──
	/** Relative time shown for timestamps less than a minute old */
	relative_just_now: "Just now",
	/** Relative time, singular minutes. {{count}} is the number of minutes */
	relative_minutes_ago_one: "{{count}} minute ago",
	/** Relative time, plural minutes. {{count}} is the number of minutes */
	relative_minutes_ago_other: "{{count}} minutes ago",
	/** Relative time, singular hours. {{count}} is the number of hours */
	relative_hours_ago_one: "{{count}} hour ago",
	/** Relative time, plural hours. {{count}} is the number of hours */
	relative_hours_ago_other: "{{count}} hours ago",
	/** Relative time, singular days. {{count}} is the number of days */
	relative_days_ago_one: "{{count}} day ago",
	/** Relative time, plural days. {{count}} is the number of days */
	relative_days_ago_other: "{{count}} days ago"
} as const
