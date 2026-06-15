// Drive feature vocabulary covering:
//   src/components/drive/index.tsx (sort menu, bulk actions, header titles, empty states, upload actions)
//   src/components/drive/item/menu.tsx (per-item context menu actions and confirmation dialogs)
//   src/components/driveSelectToolbar.tsx (move/select destination toolbar)
//   src/routes/driveItemInfo/index.tsx (item information sheet metadata labels)
//   src/routes/changeDirectoryColor/index.tsx (directory color picker screen)
//   src/routes/tabs/_layout.tsx (bottom tab labels)
//   src/routes/offline/_layout.tsx (offline sync indicator)
//
// Shared keys (cancel, create, rename, move, share, download, upload, import, export, copy,
// remove, delete, trash, restore, favorite, unfavorite, open, info, settings, select, deselect,
// select_all, deselect_all, selected_one, selected_other, delete_selected, type, file, directory,
// no_permissions_enable_manually, disable, enable) live in common.ts — never redefine them here.
//
// "Filen" is a brand name and must NOT be translated. The literal string "Filen" in
// copyToMediaStore `parentFolder` is intentionally left as a code constant, not a key.
//
// Sort keys also live here because buildSortMenuButton is defined in
// drive/components/headerMenuBuilders.ts (the sort.ts file currently covers
// notes-grouping labels only).
export const drive = {
	// ── Public-link password prompts (src/lib/drive.ts openLinkedDirectory / openLinkedFile) ──
	// password_required lives in common.ts.
	/** Public-link password prompt — dialog message asking for a protected directory link's password */
	enter_public_link_directory_password: "Enter the password for this directory link",
	/** Public-link password prompt — dialog message asking for a protected file link's password */
	enter_public_link_file_password: "Enter the password for this file link",

	// ── Sort menu (buildSortMenuButton in drive/components/headerMenuBuilders.ts) ──
	/** Sort menu top-level button title */
	sort_by: "Sort by",
	/** Sort submenu group: sort by name */
	sort_name: "Name",
	/** Sort option: sort by name A → Z */
	sort_name_asc: "Name (A–Z)",
	/** Sort option: sort by name Z → A */
	sort_name_desc: "Name (Z–A)",
	/** Sort submenu group: sort by file size */
	sort_size: "Size",
	/** Sort option: sort by size smallest first */
	sort_size_asc: "Size (small first)",
	/** Sort option: sort by size largest first */
	sort_size_desc: "Size (large first)",
	/** Sort submenu group: sort by item type / MIME */
	sort_type: "Type",
	/** Sort option: sort by type A → Z */
	sort_type_asc: "Type (A–Z)",
	/** Sort option: sort by type Z → A */
	sort_type_desc: "Type (Z–A)",
	/** Sort submenu group: sort by last-modified date */
	sort_modified: "Modified",
	/** Sort option: sort by modified date oldest first */
	sort_modified_asc: "Modified (oldest first)",
	/** Sort option: sort by modified date newest first */
	sort_modified_desc: "Modified (newest first)",
	/** Sort submenu group: sort by upload date */
	sort_uploaded: "Uploaded",
	/** Sort option: sort by upload date oldest first */
	sort_uploaded_asc: "Uploaded (oldest first)",
	/** Sort option: sort by upload date newest first */
	sort_uploaded_desc: "Uploaded (newest first)",
	/** Sort submenu group: sort by creation date */
	sort_created: "Created",
	/** Sort option: sort by creation date oldest first */
	sort_created_asc: "Created (oldest first)",
	/** Sort option: sort by creation date newest first */
	sort_created_desc: "Created (newest first)",

	// ── Header / navigation section titles ────────────────────────────────────
	/** Header title for the root drive view and breadcrumb fallback */
	drive: "Drive",
	/** Header title for the offline files view */
	offline: "Offline",
	/** Header title for the shared-with-me view */
	shared_with_me: "Shared with you",
	/** Header title for the shared-with-others view */
	shared_with_others: "Shared with others",
	/** Header title for the public links view */
	links: "Links",
	/** Header title for the favorites view */
	favorites: "Favorites",
	/** Header title for the linked (public link directory) view */
	linked: "Linked",
	/** Header title for the recents view */
	recents: "Recents",

	// ── Header search bar ─────────────────────────────────────────────────────
	/** Search bar placeholder in the drive header */
	search_drive: "Search",

	// ── Picker-mode header titles (drive/index.tsx headerTitle switch) ────────
	/** Picker header: select the destination directory for a move operation */
	select_destination: "Select destination",
	/** Picker header: choose a single item (any type) */
	select_item: "Select item",
	/** Picker header: choose multiple items (any type) */
	select_items: "Select items",
	/** Picker header: choose a single directory */
	select_directory: "Select directory",
	/** Picker header: choose multiple directories */
	select_directories: "Select directories",
	/** Picker header: choose a single file */
	select_file: "Select file",
	/** Picker header: choose multiple files */
	select_files: "Select files",

	// ── Upload sub-menu actions ────────────────────────────────────────────────
	/** Upload sub-menu group button title */
	upload_files: "Upload files",
	/** Upload sub-menu item: pick photos or videos from the device library */
	upload_photos_or_videos: "Upload photos or videos",
	// take_photo_or_video lives in common.ts.
	/** Upload sub-menu item: scan a physical document using the device camera */
	scan_document: "Scan document",
	/** Upload sub-menu item: create a new empty text file */
	create_text_file: "Create text file",
	/** Success toast after an upload batch (all succeeded). {{count}} = files uploaded */
	upload_complete_one: "Uploaded {{count}} file",
	/** Success toast after an upload batch (all succeeded, plural) */
	upload_complete_other: "Uploaded {{count}} files",
	/** Toast after an upload batch where some uploads failed. {{count}} = succeeded, {{failed}} = failed */
	upload_complete_with_failures_one: "Uploaded {{count}} file, {{failed}} failed",
	/** Toast after an upload batch where some uploads failed (plural) */
	upload_complete_with_failures_other: "Uploaded {{count}} files, {{failed}} failed",

	// ── Create directory prompt ────────────────────────────────────────────────
	/** Create-directory dialog title and menu button label */
	create_folder: "Create directory",
	/** Create-directory dialog message */
	enter_folder_name: "Enter a name for the new directory",
	/** Create-directory dialog input placeholder */
	folder_name: "Directory name",

	// ── Create text file prompt ────────────────────────────────────────────────
	/** Create-text-file dialog message */
	enter_text_file_name: "Enter a name for the new text file",
	/** Create-text-file dialog input placeholder */
	text_file_name: "File name",

	// ── Scanned document filename base (drive/index.tsx) ─────────────────────
	// The component appends an ISO-8601 timestamp and ".jpg" to form the final filename.
	// Translators: keep it filename-safe (no slashes, colons, or special characters).
	/** Base name for a scanned document file — a timestamp is appended to make it unique */
	scanned_document_name: "Scanned document",

	// ── Transfers / sync menu actions ─────────────────────────────────────────
	/** Menu button that triggers an immediate offline-cache sync */
	sync_now: "Sync now",
	/** Disabled menu button / offline indicator shown while syncing is in progress */
	syncing: "Syncing…",

	// ── Offline sync errors (features/offline screens/syncErrors.tsx + offline listing) ──
	/** Header title of the offline sync errors screen */
	offline_sync_errors: "Sync errors",
	/** Pressable list-header row on the offline root listing that opens the sync errors screen. {{count}} = number of sync errors */
	offline_sync_errors_count_one: "{{count}} sync error",
	/** Pressable list-header row on the offline root listing that opens the sync errors screen. {{count}} = number of sync errors */
	offline_sync_errors_count_other: "{{count}} sync errors",
	/** Empty state of the sync errors screen when the last sync pass produced no errors */
	no_offline_sync_errors: "No sync errors",
	/** Empty-state subtitle on the offline sync-errors screen when there are no errors (the clean state) */
	no_offline_sync_errors_description: "All your offline files are up to date.",
	/** Per-row indicator on the offline listing for an item whose last sync attempt failed */
	offline_sync_failed: "Sync failed",
	/** Sync error kind label: downloading the file's content failed */
	offline_sync_error_kind_download: "Download",
	/** Sync error kind label: listing the directory's contents failed */
	offline_sync_error_kind_listing: "Listing",
	/** Sync error kind label: verifying the stored file's integrity failed */
	offline_sync_error_kind_verify: "Verification",
	/** Sync error kind label: storing the file to the offline cache failed */
	offline_sync_error_kind_store: "Storage",

	// ── Bulk-selection actions (drive/index.tsx Header) ───────────────────────
	// restore_selected, favorite_selected, unfavorite_selected, download_selected,
	// make_available_offline_selected and trash_selected live in common.ts.
	/** Bulk action: permanently delete all selected items */
	delete_selected_permanently: "Delete selected permanently",
	/** Bulk action: move all selected items to a new location */
	move_selected: "Move selected",
	/** Bulk action: save all selected image/video items to the device photo library */
	save_to_photos_selected: "Save to photos",
	/** Bulk action: share all selected items with a Filen user */
	share_filen_user_selected: "Share with Filen user",
	/** Bulk action: remove offline cache for all selected items */
	remove_offline_selected: "Remove from offline",
	/** Bulk action: stop sharing all selected outgoing-share items */
	stop_sharing_selected: "Stop sharing selected",
	/** Bulk action: remove all selected incoming-share items */
	remove_share_selected: "Remove from shared with me",
	/** Bulk action: disable public link for all selected items */
	disable_public_link_selected: "Disable public link for selected",

	// ── Bulk confirmation dialogs ─────────────────────────────────────────────
	/** Confirmation body for bulk restore */
	are_you_sure_restore_selected: "Are you sure you want to restore the selected items?",
	/** Confirmation body for bulk permanent delete */
	are_you_sure_delete_selected_permanently: "Are you sure you want to permanently delete the selected items? This cannot be undone.",
	/** Confirmation body for bulk trash */
	are_you_sure_trash_selected: "Are you sure you want to move the selected items to the trash? You can restore them later.",
	/** Confirmation body for bulk stop-sharing */
	are_you_sure_stop_sharing_selected: "Are you sure you want to stop sharing the selected items?",
	/** Confirmation body for bulk remove-share */
	are_you_sure_remove_share_selected: "Are you sure you want to remove the selected items from Shared with me?",
	/** Confirmation body for bulk disable-public-link */
	are_you_sure_disable_public_link_selected: "Are you sure you want to disable the public link for the selected items?",
	/** Confirmation body for bulk remove-offline */
	confirm_remove_offline_selected: "Are you sure you want to remove the selected items from offline storage?",
	/** Confirm button label for bulk remove-offline dialog */
	remove_offline: "Remove from offline",

	// ── Empty trash actions / confirmation ────────────────────────────────────
	/** Menu button and dialog title: permanently delete every item in the trash */
	empty_trash: "Empty trash",
	/** Confirmation body for emptying the trash */
	are_you_sure_empty_trash: "Are you sure you want to permanently delete everything in the trash? This cannot be undone.",
	/** Confirm button for the empty-trash dialog */
	empty: "Empty",

	// ── Empty-state titles (ListEmpty component) ──────────────────────────────
	/** Empty state when the trash contains no items */
	trash_is_empty: "Trash is empty",
	/** Empty state when the user has no favorited items */
	no_favorites: "No favorites",
	/** Empty state when there are no recent items */
	no_recents: "No recents",
	/** Empty state when no items have been shared with the user */
	no_shared_in_items: "Nothing shared with you",
	/** Empty state when the user has not shared any items */
	no_shared_out_items: "Nothing shared with others",
	/** Empty state when the user has no public links */
	no_links: "No links",
	/** Empty state when no items are available offline */
	no_offline_items: "No offline items",
	/** Empty state for a directory that contains no items */
	folder_is_empty: "This directory is empty",
	/** Empty-state subtitle for an empty directory (ListEmpty) */
	folder_is_empty_description: "Upload files or create a directory to fill it.",
	/** Empty-state subtitle for the trash view */
	trash_is_empty_description: "Items you move to the trash will appear here.",
	/** Empty-state subtitle for the favorites view */
	no_favorites_description: "Items you mark as favorites will appear here.",
	/** Empty-state subtitle for the recents view */
	no_recents_description: "Files you open will appear here.",
	/** Empty-state subtitle for the shared-with-you view */
	no_shared_in_items_description: "Items others share with you will appear here.",
	/** Empty-state subtitle for the shared-with-others view */
	no_shared_out_items_description: "Items you share will appear here.",
	/** Empty-state subtitle for the public-links view */
	no_links_description: "Public links you create will appear here.",
	/** Empty-state subtitle for the offline-files view */
	no_offline_items_description: "Files you make available offline will appear here.",
	/** Error-state title shown when a directory listing fails to load */
	could_not_load_directory: "Couldn't load this directory",

	// ── Per-item context menu actions (drive/item/menu.tsx) ───────────────────
	/** Per-item context menu: download item to the device filesystem */
	download_to_device: "Download to device",
	/** Per-item context menu: make the item available when offline */
	make_available_offline: "Make available offline",
	/** Per-item context menu: save image or video to the device photo library */
	save_to_photos: "Save to photos",
	/** Per-item context menu sub-item: create a shareable public link */
	share_public_link: "Share public link",
	/** Per-item context menu sub-item: share item with another Filen user */
	share_filen_user: "Share with Filen user",
	/** Per-item context menu: remove an item that someone shared with the current user */
	remove_share: "Remove share",
	/** Per-item context menu: stop sharing an item that the current user owns */
	stop_sharing: "Stop sharing",
	/** Per-item context menu: disable the public link for this item */
	disable_public_link: "Disable public link",
	/** Per-item context menu (links screen): open the public-link screen to edit the link's settings */
	edit_public_link: "Edit public link",
	/** Per-item context menu (links screen): copy the public link URL to the clipboard */
	copy_link: "Copy link",
	/** Per-item context menu: view file version history */
	versions: "Versions",
	/** Per-item context menu: change the directory icon color */
	color: "Color",
	/** Per-item context menu: permanently delete the item (trash view only) */
	delete_permanently: "Delete permanently",

	// ── Per-item rename prompt ─────────────────────────────────────────────────
	/** Rename-item dialog title */
	rename_item: "Rename",
	// enter_new_name lives in common.ts.

	// ── Per-item confirmation dialogs ─────────────────────────────────────────
	/** Confirmation dialog title for permanently deleting a single item */
	delete_permanently_item: "Delete permanently",
	/** Confirmation body for permanently deleting a single item */
	confirm_delete_permanently: "Are you sure you want to permanently delete this item? This cannot be undone.",
	/** Confirmation dialog title for trashing a single item */
	trash_item: "Trash",
	/** Confirmation body for trashing a single item */
	confirm_trash: "Are you sure you want to move this item to the trash? You can restore it later.",
	/** Confirmation dialog title for removing a single item from offline storage */
	remove_offline_item: "Remove offline",
	/** Confirmation body for removing a single item from offline storage */
	confirm_remove_offline: "Are you sure you want to remove this item from offline storage?",
	/** Confirmation dialog title for removing a single incoming share */
	remove_share_item: "Remove share",
	/** Confirmation body for removing a single incoming share */
	confirm_remove_share: "Are you sure you want to remove this share?",
	/** Confirmation dialog title for stopping outgoing share of a single item */
	stop_sharing_item: "Stop sharing",
	/** Confirmation body for stopping outgoing share of a single item */
	confirm_stop_sharing: "Are you sure you want to stop sharing this item?",
	/** Confirmation dialog title and button for disabling a public link */
	confirm_disable_public_link: "Are you sure you want to disable the public link for this item?",

	// ── DriveSelectToolbar (driveSelectToolbar.tsx) ───────────────────────────
	/** Create-directory dialog title in the drive-select (move picker) toolbar */
	create_directory: "Create directory",
	/** Create-directory dialog message in the drive-select toolbar */
	enter_directory_name: "Enter a name for the new directory",
	/** Confirm button in the move toolbar: moves selected items into the current directory */
	move_here: "Move here",
	/** Select toolbar confirm button shown when a root directory is selected with no item selected */
	select_root: "Select this directory",
	/** Select toolbar confirm button: select {{count}} items (singular) */
	select_n_items_one: "Select {{count}} item",
	/** Select toolbar confirm button: select {{count}} items (plural) */
	select_n_items_other: "Select {{count}} items",

	// ── Drive item info sheet (driveItemInfo/index.tsx) ───────────────────────
	/** Info-sheet section heading */
	information: "Information",
	/** Info-sheet row label: MIME type of the file */
	mime: "MIME type",
	/** Info-sheet row label: how the file can be previewed in the app */
	preview_type: "Preview type",
	/** Info-sheet row label: size on disk */
	size: "Size",
	/** Info-sheet row label: number of files inside a directory */
	files: "Files",
	/** Info-sheet row label: number of sub-directories inside a directory */
	directories: "Directories",
	/** Info-sheet row label: creation date */
	created: "Created",
	/** Info-sheet row label: last-modified date */
	modified: "Modified",
	/** Info-sheet row label: upload date */
	uploaded: "Uploaded",
	/** Info-sheet row label: whether the item is cached for offline use */
	offline_status: "Available offline",
	/** Header title of the item-info sheet */
	item_info: "Info",

	// ── Preview-type values in the info sheet ─────────────────────────────────
	/** Preview type label: audio file (plays in the in-app audio player) */
	preview_type_audio: "Audio",
	/** Preview type label: source code file (shown with syntax highlighting) */
	preview_type_code: "Code",
	/** Preview type label: Word document (.docx) rendered via DOCX viewer */
	preview_type_docx: "Document",
	/** Preview type label: PDF file */
	preview_type_pdf: "PDF",
	/** Preview type label: image file */
	preview_type_image: "Image",
	/** Preview type label: plain-text file */
	preview_type_text: "Text",
	/** Preview type label: video file */
	preview_type_video: "Video",
	/** Preview type label: file type not supported for in-app preview */
	preview_type_unknown: "Not previewable",

	// ── Change directory color screen (changeDirectoryColor/index.tsx) ────────
	/** Header title for the directory-color picker screen */
	change_directory_color: "Change color",

	// ── Download partial-failure toast (driveDownload.ts) ────────────────────
	/** Toast shown when a directory download succeeds for some files but fails for others.
	 *  {{failed}} = number of files that failed, {{total}} = total files attempted */
	download_partial_failure: "{{failed}} of {{total}} files could not be saved to Downloads",
	/** Error shown when a directory download-to-device resolved but the SDK reported per-entry
	 *  failures — the saved directory is missing {{count}} file (singular) */
	download_missing_files_one: "Downloaded with {{count}} missing file",
	/** Error shown when a directory download-to-device resolved but the SDK reported per-entry
	 *  failures — the saved directory is missing {{count}} files (plural) */
	download_missing_files_other: "Downloaded with {{count}} missing files",

	// ── Import partial-failure errors (menuActionsDownload.ts) ────────────────
	/** Error shown when the Import flow's download step left {{count}} file missing — the
	 *  re-upload is skipped and the local staging copy is kept (singular) */
	import_partial_download_one: "Import cancelled: {{count}} file could not be downloaded",
	/** Error shown when the Import flow's download step left {{count}} files missing (plural) */
	import_partial_download_other: "Import cancelled: {{count}} files could not be downloaded",
	/** Error shown when the Import flow's upload step failed for {{count}} file — the local
	 *  staging copy is kept (singular) */
	import_partial_upload_one: "Import incomplete: {{count}} file could not be uploaded",
	/** Error shown when the Import flow's upload step failed for {{count}} files (plural) */
	import_partial_upload_other: "Import incomplete: {{count}} files could not be uploaded",

	// ── Bottom tab labels (routes/tabs/_layout.tsx) ───────────────────────────
	/** Bottom tab label for the drive (files) tab */
	tab_drive: "Drive",
	/** Bottom tab label for the photos tab */
	tab_photos: "Photos",
	/** Bottom tab label for the notes tab */
	tab_notes: "Notes",
	/** Bottom tab label for the chats tab */
	tab_chats: "Chats",
	/** Bottom tab label for the more (settings) tab */
	tab_more: "More"
} as const
