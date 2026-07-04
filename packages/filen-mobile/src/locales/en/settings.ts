// Settings feature vocabulary — the "More" tab and its sub-screens (account, personal info,
// advanced cache, file/documents provider, events log + event details). Shared keys (cancel,
// save, delete, logout, clear, continue, close, open, name, email, yes, no,
// no_permissions_enable_manually, cannot_open_link) live in common.ts and must NOT be redefined.
//
// Plural/interpolation notes:
//  - used_of interpolates {{used}} and {{max}} (already-formatted byte strings).
//  - offline_files_count / offline_dirs_count are ICU plural pairs ({{count}}).
// Event-kind labels (file_uploaded, directory_renamed, …) are resolved from a typed map in
// src/features/events/eventDetails.ts with the module-level i18n.t because eventKindToReadable() is a
// plain (non-React) function and cannot use the useTranslation() hook.
export const settings = {
	// ── More tab (top-level settings menu) ────────────────────────────────────
	/** "More" tab — header title and tab label (the settings hub) */
	more: "More",
	/** Account-card subtitle on the More tab: used vs. total storage. {{used}} and {{max}} are formatted sizes (e.g. "2.1 GB") */
	used_of: "{{used}} of {{max}}",
	/** Storage legend — versioned-files segment */
	versioned_files: "Versioned files",
	/** Storage legend — free/remaining segment */
	free: "Free",
	/** Account-card subtitle — plan tier for accounts with no paid subscription. Distinct from the "free space" legend label above: this is the no-cost plan (e.g. German "Kostenlos", not "Frei") */
	free_plan: "Free",
	/** Account-card subtitle — plan tier for any paid/premium account. Storage from stacked plans is combined, so we show one "Pro" tier rather than a plan name */
	pro: "Pro",
	// More-menu rows reuse keys defined in their owning feature files: recents, favorites,
	// shared_with_me, shared_with_others (drive.ts); contacts (contacts.ts); playlists (media.ts);
	// security (security.ts); appearance (appearance.ts).
	/** More-menu row: files saved for offline access */
	saved_offline: "Saved offline",
	/** More-menu row: your public share links */
	public_links: "Public links",
	/** More-menu row: account activity / events log */
	events: "Events",
	/** More-menu row: advanced settings (caches, debug) */
	advanced: "Advanced",
	/** More screen — opens the Terms of Service (filen.io/terms) in the browser */
	terms_of_service: "Terms of Service",
	/** More screen — opens the Privacy Policy (filen.io/privacy) in the browser */
	privacy_policy: "Privacy Policy",

	// ── Offline settings screen ───────────────────────────────────────────────
	// (screen title reuses the existing `offline` key from drive.ts)
	/** Offline settings — toggle title: restrict offline syncing to Wi-Fi */
	sync_offline_on_wifi_only: "Sync on Wi-Fi only",
	/** Offline settings — subtitle under the Wi-Fi-only toggle */
	sync_offline_on_wifi_only_description: "Only sync your offline files when connected to Wi-Fi.",
	/** Offline settings — toggle title: periodic background syncing of offline files */
	sync_offline_in_background: "Sync in background",
	/** Offline settings — subtitle under the background-sync toggle */
	sync_offline_in_background_description:
		"Periodically sync your offline files while the app is in the background. Large directories are skipped and sync when you open the app, to save battery and data.",

	// ── File / Documents Provider (platform-conditional) ──────────────────────
	/** iOS-only feature name: integration with the system Files app (File Provider extension) */
	file_provider: "File Provider",
	/** Android-only feature name: integration with the system document picker (Documents Provider) */
	documents_provider: "Documents Provider",
	/** iOS File Provider — description shown under the toggle explaining the integration */
	file_provider_description: "Access your Filen files directly from the Files app. Files are streamed on demand and cached locally.",
	/** Android Documents Provider — description shown under the toggle explaining the integration */
	documents_provider_description:
		"Access your Filen files directly from the system document picker. Files are streamed on demand and cached locally.",
	/** File Provider — local cache size limit row title */
	cache_size: "Cache size",
	/** File Provider — subtitle under the cache-size row */
	cache_size_description: "Maximum disk space used to cache downloaded files",
	/** File Provider — suffix marking the currently selected cache-size option in the picker */
	current: "Current",
	/** Confirm dialog title shown when enabling the provider while biometric lock is on */
	file_provider_disables_biometric_title: "Biometric lock will be turned off",
	/** Confirm dialog message: the native provider bypasses the in-app biometric gate, so enabling it disables biometric lock */
	file_provider_disables_biometric_message:
		"The provider lets the system access your files directly, bypassing the in-app biometric lock. Enabling it will turn off biometric lock. Do you want to continue?",

	// ── Account screen ────────────────────────────────────────────────────────
	/** Account screen — header title */
	account: "Account",
	/** Account screen — row to pick and upload a new profile avatar image */
	change_avatar: "Change avatar",
	/** Error shown when the picked avatar file is not an image */
	avatar_not_an_image: "Please choose an image file.",
	/** Error shown when the picked avatar image is in a format that cannot be used */
	avatar_unsupported_format: "This image format is not supported. Please choose a different image.",
	/** Generic error shown when uploading the chosen avatar image fails */
	avatar_upload_failed: "Could not update your avatar. Please try again.",
	/** Account screen — row title to change the account email address */
	change_email_address: "Change email address",
	/** Account screen — input prompt for the new email address */
	enter_new_email_address: "Enter your new email address",
	/** Account screen — input prompt to confirm the new email address a second time */
	confirm_new_email_address: "Confirm your new email address",
	/** Error toast when the two entered email addresses differ */
	email_addresses_do_not_match: "Email addresses do not match",
	/** Input prompt asking for the account password to authorize a change */
	enter_password: "Enter your password",
	/** Account screen — row title to change the display nickname */
	change_nickname: "Change nickname",
	/** Account screen — input prompt for the new nickname */
	enter_nickname: "Enter your nickname",
	/** Account screen — row opening the personal information sub-screen */
	personal_information: "Personal information",
	/** Account screen — subtitle for the personal information row */
	personal_information_description: "Manage your name, address and tax details",
	/** Account screen — row that exports your GDPR data as a file */
	gdpr_information: "GDPR information",
	/** Account screen — subtitle for the GDPR information row */
	gdpr_information_description: "Export the personal data we hold about you",
	/** Account screen — row that opens the web app for settings not available on mobile */
	more_account_settings: "More account settings",
	/** Confirm dialog title before opening the Filen web app in a browser */
	open_web_app: "Open web app",
	/** Confirm dialog message before opening the web app to change additional settings */
	open_web_app_to_change_more_settings_do_you_want_to_open_it: "Open the Filen web app to change more settings. Do you want to open it?",
	/** Account screen — row title toggling file versioning */
	file_versioning: "File versioning",
	/** Account screen — subtitle for the file versioning toggle */
	file_versioning_description: "Keep previous versions of changed files",
	/** Account screen — row title toggling login alert emails */
	login_alerts: "Login alerts",
	/** Account screen — subtitle for the login alerts toggle */
	login_alerts_description: "Get notified by email about new logins to your account",

	// ── Account danger zone ───────────────────────────────────────────────────
	/** Account screen — section header for irreversible, destructive actions */
	danger_zone: "Danger zone",
	/** Generic confirmation dialog title: "Are you sure?" (second confirmation step) */
	are_you_sure: "Are you sure?",
	/** Danger zone — row title to delete all stored file versions */
	delete_versioned_files: "Delete versioned files",
	/** Danger zone — first confirm message warning that deleting versions cannot be undone */
	delete_versioned_files_description_non_reversible:
		"This permanently deletes all previous versions of your files. This cannot be undone.",
	/** Danger zone — second confirm message for deleting versioned files */
	delete_versioned_files_description_are_you_sure: "Are you sure you want to delete all versioned files?",
	/** Danger zone — row title to delete every file and directory in the account */
	delete_all_files_and_directories: "Delete all files and directories",
	/** Danger zone — first confirm message warning that deleting everything cannot be undone */
	delete_all_files_and_directories_description_non_reversible:
		"This permanently deletes all of your files and directories. This cannot be undone.",
	/** Danger zone — second confirm message for deleting all files and directories */
	delete_all_files_and_directories_description_are_you_sure: "Are you sure you want to delete all of your files and directories?",
	/** Danger zone — row title to request account deletion */
	request_account_deletion: "Request account deletion",
	/** Danger zone — subtitle for the account-deletion row */
	request_account_deletion_description: "Permanently delete your Filen account",
	/** Danger zone — confirm button verb for requesting account deletion */
	request: "Request",
	/** Danger zone — first confirm message: deletion is irreversible and starts with a confirmation email */
	request_account_deletion_description_non_reversible_will_send_email_first_to_confirm:
		"This will permanently delete your account and cannot be undone. We will first send a confirmation email before anything is deleted.",
	/** Danger zone — second confirm message for requesting account deletion */
	request_account_deletion_description_non_reversible_will_send_email_first_to_confirm_are_you_sure:
		"Are you sure you want to request deletion of your account?",
	// enter_two_factor_code lives in security.ts.
	/** Two-factor input prompt message shown during account-deletion confirmation */
	enter_two_factor_code_description_confirm: "Enter your two-factor authentication code to confirm",
	/** Toast after an account-deletion request: confirmation instructions were emailed */
	account_deletion_requested_follow_instructions_sent_to_email:
		"Account deletion requested. Please follow the instructions we sent to your email.",
	/** Confirm dialog message before logging out: local data will be wiped */
	logout_confirm_wipes_local_data: "Logging out will wipe all locally stored data from this device. Are you sure you want to log out?",

	// ── Personal information sub-screen ───────────────────────────────────────
	/** Personal info — placeholder shown for a field that has no value yet */
	not_set: "Not set",
	/** Personal info — first name field label */
	first_name: "First name",
	/** Personal info — input prompt for the first name */
	enter_new_first_name: "Enter your first name",
	/** Personal info — last name field label */
	last_name: "Last name",
	/** Personal info — input prompt for the last name */
	enter_new_last_name: "Enter your last name",
	/** Personal info — company name field label */
	company_name: "Company name",
	/** Personal info — input prompt for the company name */
	enter_new_company_name: "Enter your company name",
	/** Personal info — VAT ID field label (keep "VAT ID" abbreviation) */
	vat_id: "VAT ID",
	/** Personal info — input prompt for the VAT ID */
	enter_new_vat_id: "Enter your VAT ID",
	/** Personal info — street field label */
	street: "Street",
	/** Personal info — input prompt for the street */
	enter_new_street: "Enter your street name",
	/** Personal info — street number field label */
	street_number: "Street number",
	/** Personal info — input prompt for the street number */
	enter_new_street_number: "Enter your street number",
	/** Personal info — city field label */
	city: "City",
	/** Personal info — input prompt for the city */
	enter_new_city: "Enter your city",
	/** Personal info — postal code field label */
	postal_code: "Postal code",
	/** Personal info — input prompt for the postal code */
	enter_new_postal_code: "Enter your postal code",
	/** Personal info — country field label (value is picked from a country action sheet) */
	country: "Country",

	// ── Advanced settings (cache management) ──────────────────────────────────
	/** Advanced — subtitle fragment counting offline files (singular). {{count}} is the count */
	offline_files_count_one: "{{count}} file",
	/** Advanced — subtitle fragment counting offline files (plural). {{count}} is the count */
	offline_files_count_other: "{{count}} files",
	/** Advanced — subtitle fragment counting offline directories (singular). {{count}} is the count */
	offline_dirs_count_one: "{{count}} directory",
	/** Advanced — subtitle fragment counting offline directories (plural). {{count}} is the count */
	offline_dirs_count_other: "{{count}} directories",
	/** Advanced & Camera Upload — row title: convert HEIC/HEIF images to JPG on upload */
	convert_heic_to_jpg: "Convert HEIC to JPG",
	/** Advanced & Camera Upload — description for the HEIC/HEIF → JPG conversion toggle */
	convert_heic_to_jpg_description:
		"Automatically convert HEIC/HEIF photos to JPG on upload for better compatibility across devices and apps.",
	/** Advanced — row title: Picture-in-Picture toggle for video playback */
	picture_in_picture: "Picture-in-Picture",
	/** Advanced — description for the Picture-in-Picture toggle; states the deliberate no-relock behavior */
	picture_in_picture_description:
		"Keep videos playing in a floating window when you leave the app. While a video is floating, returning to the app will not ask you to unlock again.",
	/** Advanced — row title: clear generated image thumbnails */
	clear_image_thumbnails: "Clear image thumbnails",
	/** Advanced — confirm message before clearing image thumbnails */
	clear_image_thumbnails_description: "This clears all cached image thumbnails. They will be regenerated as needed.",
	/** Toast after image thumbnails were cleared */
	image_thumbnails_cleared: "Image thumbnails cleared",
	/** Advanced — row title: clear cached file previews */
	clear_preview_cache: "Clear preview cache",
	/** Advanced — confirm message before clearing the preview cache */
	clear_preview_cache_description: "This clears all cached file previews. They will be re-downloaded as needed.",
	/** Toast after the preview cache was cleared */
	preview_cache_cleared: "Preview cache cleared",
	/** Advanced — row title: clear cached music metadata and cover art */
	clear_music_metadata: "Clear music metadata",
	/** Advanced — confirm message before clearing music metadata */
	clear_music_metadata_description: "This clears all cached music metadata and cover art. It will be re-fetched as needed.",
	/** Toast after music metadata was cleared */
	music_metadata_cleared: "Music metadata cleared",
	/** Advanced — row title: clear the OS sandbox cache */
	clear_sandbox_cache: "Clear temporary cache",
	/** Advanced — confirm message before clearing the sandbox cache */
	clear_sandbox_cache_description: "This clears temporary files stored in the app cache.",
	/** Toast after the sandbox cache was cleared */
	sandbox_cache_cleared: "Temporary cache cleared",
	/** Advanced — row title: clear every disk cache at once */
	clear_all_disk_caches: "Clear all disk caches",
	/** Advanced — subtitle for the clear-all-disk-caches row */
	clear_all_disk_caches_description: "Clears thumbnails, previews, music metadata, and the temporary cache",
	/** Advanced — confirm message before clearing all disk caches */
	clear_all_disk_caches_confirmation: "This clears all disk caches. Cached data will be regenerated or re-downloaded as needed.",
	/** Toast after all disk caches were cleared */
	all_disk_caches_cleared: "All disk caches cleared",
	/** Advanced — display-only row title: on-disk size of the local search index (not clearable) */
	search_index: "Search index",
	/** Advanced — row title: remove all files saved for offline access */
	clear_offline_files: "Clear offline files",
	/** Advanced — confirm message before clearing offline files (they remain in the cloud) */
	clear_offline_files_confirmation:
		"This removes all files saved for offline access from this device. They remain available in the cloud.",
	/** Toast after offline files were cleared */
	offline_files_cleared: "Offline files cleared",
	/** Advanced — row title: remove leftover temporary/staging files and partial downloads */
	clean_temporary_files: "Clean up leftover files",
	/** Advanced — row subtitle describing what the temporary-file cleanup removes */
	clean_temporary_files_description: "Removes leftover staging files and partial downloads from interrupted sessions",
	/** Advanced — confirm message before cleaning temporary files */
	clean_temporary_files_confirmation:
		"This removes leftover staging files and partial downloads from interrupted sessions. Nothing stored in the cloud is affected.",
	/** Advanced — shown when temporary-file cleanup is blocked because transfers or syncs are running */
	clean_temporary_files_unavailable: "Not available while transfers or syncs are running",
	/** Toast after temporary files were cleaned up */
	temporary_files_cleaned: "Leftover files cleaned up",

	// ── Events log + event details ────────────────────────────────────────────
	/** Events screen — empty-state title when there is no account activity */
	no_events: "No events",
	/** Events screen — empty-state subtitle shown when the server returned events but all are undecryptable (rotated/legacy keys); {{count}} is the number of undecryptable events */
	events_undecryptable_one: "{{count}} event could not be decrypted",
	/** Events screen — empty-state subtitle (plural) shown when the server returned events but all are undecryptable */
	events_undecryptable_other: "{{count}} events could not be decrypted",
	/** Event details — header title */
	event_info: "Event info",
	/** Event details — row label for the kind/type of event */
	event_type: "Event type",
	/** Event details — row label for when the event occurred */
	timestamp: "Timestamp",
	/** Event details — row label for the originating IP address (keep "IP" abbreviation) */
	ip: "IP",
	/** Event details — row label for the originating device/browser user agent */
	user_agent: "User agent",
	/** Event details — row label for an item's previous name (before a rename) */
	old_name: "Old name",
	/** Event details — row label for the email address a share was sent to */
	receiver_email: "Receiver email",
	/** Event details — row label for the email address a share was received from */
	sharer_email: "Sharer email",
	/** Event details — row label for a public link's UUID (keep "UUID") */
	link_uuid: "Link UUID",
	/** Event details — row label for a redeemed code */
	code: "Code",
	/** Event details — row label for a previous email address (before an email change) */
	old_email: "Old email",
	/** Event details — row label for a new email address (after an email change) */
	new_email: "New email",
	// favorited (event-detail label) lives in sort.ts.
	/** Event details — row label for the number of items affected */
	count: "Count",
	/** Event details — placeholder shown when an item's name could not be decrypted */
	encrypted: "Encrypted",

	// ── Event kind labels (resolved via module i18n.t in a typed map) ─────────
	/** Event kind: a file was uploaded */
	file_uploaded: "File uploaded",
	/** Event kind: a new version of a file was created */
	file_versioned: "File versioned",
	/** Event kind: a file was restored from trash */
	file_restored: "File restored",
	/** Event kind: a previous file version was restored */
	versioned_file_restored: "Versioned file restored",
	/** Event kind: a file was moved */
	file_moved: "File moved",
	/** Event kind: a file was renamed */
	file_renamed: "File renamed",
	/** Event kind: a file's metadata was changed */
	file_metadata_changed: "File metadata changed",
	/** Event kind: a file was moved to trash */
	file_trash: "File trashed",
	/** Event kind: a file was permanently removed */
	file_rm: "File deleted",
	/** Event kind: a file was shared */
	file_shared: "File shared",
	/** Event kind: a file's public link was edited */
	file_link_edited: "File link edited",
	/** Event kind: a file was permanently deleted */
	delete_file_permanently: "File permanently deleted",
	/** Event kind: a directory was moved to trash */
	directory_trash: "Directory trashed",
	/** Event kind: a directory was shared */
	directory_shared: "Directory shared",
	/** Event kind: a directory was moved */
	directory_moved: "Directory moved",
	/** Event kind: a directory was renamed */
	directory_renamed: "Directory renamed",
	/** Event kind: a directory's metadata was changed */
	directory_metadata_changed: "Directory metadata changed",
	/** Event kind: a sub-directory was created */
	sub_directory_created: "Sub-directory created",
	/** Event kind: a base directory was created */
	base_directory_created: "Base directory created",
	/** Event kind: a directory was restored from trash */
	directory_restored: "Directory restored",
	/** Event kind: a directory's color was changed */
	directory_color_changed: "Directory color changed",
	/** Event kind: a directory was permanently deleted */
	delete_directory_permanently: "Directory permanently deleted",
	/** Event kind: a directory's public link was edited */
	directory_link_edited: "Directory link edited",
	/** Event kind: a successful login */
	login: "Login",
	/** Event kind: a failed login attempt */
	failed_login: "Failed login",
	/** Event kind: the account password was changed */
	password_changed: "Password changed",
	/** Event kind: two-factor authentication was enabled */
	two_fa_enabled: "Two-factor authentication enabled",
	/** Event kind: two-factor authentication was disabled */
	two_fa_disabled: "Two-factor authentication disabled",
	/** Event kind: the trash was emptied */
	trash_emptied: "Trash emptied",
	/** Event kind: all files were deleted */
	all_files_deleted: "All files deleted",
	/** Event kind: all versioned files were deleted */
	delete_versioned: "Versioned files deleted",
	/** Event kind: unfinished uploads were deleted */
	delete_unfinished: "Unfinished uploads deleted",
	/** Event kind: a promo/redeem code was redeemed */
	code_redeemed: "Code redeemed",
	/** Event kind: the account email was changed */
	email_changed: "Email changed",
	/** Event kind: an attempt to change the account email */
	email_change_attempt: "Email change attempt",
	/** Event kind: items shared with you were removed */
	removed_shared_in_items: "Removed shared-in items",
	/** Event kind: items you shared with others were removed */
	removed_shared_out_items: "Removed shared-out items",
	/** Event kind: an item was favorited or unfavorited */
	item_favorite: "Favorite status changed",

	// ── Empty-state subtitles (ListEmpty descriptions) ────────────────────────
	/** Events — empty-state subtitle when there is no account activity yet */
	no_events_description: "Your account activity will appear here.",
	/** Account / Security / 2FA — error-state title shown when the account could not be loaded */
	could_not_load_account: "Couldn't load your account",

	// ── Diagnostics (Advanced → Logs) ─────────────────────────────────────────
	/** Logs viewer — screen title */
	logs: "Logs",
	/** Advanced — open the in-app log viewer */
	view_logs: "View logs",
	/** Advanced — subtitle for the view-logs row */
	view_logs_description: "See the diagnostic logs you can export, newest first.",
	/** Logs viewer — empty-state title */
	no_logs: "No logs yet",
	/** Logs viewer — empty-state subtitle */
	no_logs_description: "Diagnostic logs will appear here as you use the app.",
	/** Logs viewer — header level-filter menu title */
	filter_logs: "Filter by level",
	/** Logs viewer — level filter option: all levels */
	log_level_all: "All",
	/** Logs viewer — level filter option: errors only */
	log_level_errors: "Errors",
	/** Logs viewer — level filter option: warnings only */
	log_level_warnings: "Warnings",
	/** Logs viewer — level filter option: info only */
	log_level_info: "Info",
	/** Logs viewer — level filter option: debug only */
	log_level_debug: "Debug",
	/** Advanced — diagnostics row title */
	export_logs: "Export logs",
	/** Advanced — diagnostics row subtitle */
	export_logs_description: "Save app diagnostic logs to share with Filen support.",
	/** Advanced — consent shown before exporting; logs may contain personal data but never secrets */
	export_logs_consent:
		"Logs may contain file and folder names, paths, and other personal information — but never your password or encryption keys. Only share them with people you trust, such as Filen support.",
	/** Advanced — confirm button on the export-logs consent dialog */
	export_logs_action: "Export",
	/** Advanced — toast shown when there are no logs to export yet */
	export_logs_none: "There are no logs to export yet.",
	/** Advanced → Transfers — upload speed cap row title */
	upload_limit: "Upload limit",
	/** Advanced → Transfers — upload speed cap row subtitle */
	upload_limit_description: "Cap how fast files upload to save data or battery",
	/** Advanced → Transfers — download speed cap row title */
	download_limit: "Download limit",
	/** Advanced → Transfers — download speed cap row subtitle */
	download_limit_description: "Cap how fast files download to save data or battery",
	/** Advanced → Transfers — performance preset row title */
	transfer_performance: "Performance",
	/** Advanced → Transfers — performance preset row subtitle */
	transfer_performance_description: "How aggressively transfers run — higher uses more battery, memory and data",
	/** Advanced → Transfers — bandwidth picker option for no limit */
	transfer_limit_unlimited: "Unlimited",
	/** Advanced → Transfers — performance preset: gentlest (fewest parallel transfers) */
	transfer_preset_battery_saver: "Battery saver",
	/** Advanced → Transfers — performance preset: default */
	transfer_preset_balanced: "Balanced",
	/** Advanced → Transfers — performance preset: faster, heavier */
	transfer_preset_performance: "Performance",
	/** Advanced → Transfers — performance preset: most aggressive */
	transfer_preset_maximum: "Maximum",
	/** Advanced → Transfers — title of the dialog shown after changing the performance preset */
	transfer_performance_updated_title: "Performance updated",
	/** Advanced → Transfers — body of the dialog telling the user the change applies on restart */
	transfer_performance_restart_required: "This change will take effect the next time you restart the app."
} as const
