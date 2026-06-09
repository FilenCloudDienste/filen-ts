// Drive preview feature vocabulary — the full-screen gallery (images/video/audio/text/pdf/docx),
// the floating-bar audio slot, and the public-link / file-versions / linked-file modal routes.
// Components: src/components/drivePreview/{gallery,galleryItem,header,previewAudio,previewPdf,previewText}.tsx,
// src/components/floatingBar/audioSlot.tsx, src/routes/{publicLink,fileVersions,linkedFile}/index.tsx.
//
// Shared keys (cancel, ok, save, edit, password, select, deselect, select_all, deselect_all,
// delete, restore, delete_selected, selected_one/_other, file, directory, enabled,
// open_external_link, open_external_link_message, open_trust, cannot_open_link) live in common.ts
// and must NOT be redefined here.
export const drivePreview = {
	// ── Gallery (gallery.tsx / galleryItem.tsx) ───────────────────────────────
	/** Gallery empty state shown when there is nothing to preview */
	no_preview: "No preview available",
	/** Gallery item state — the file can't be shown because the device is offline and it isn't cached locally */
	unavailable_offline: "This file is not available offline",
	// unknown_artist lives in media.ts.

	// ── Gallery header (header.tsx) — external-link menu ───────────────────────
	/** Header menu action for an external (non-Filen) preview item: open the linked URL in the browser */
	open_link: "Open link",

	// ── PDF preview (previewPdf.tsx) ───────────────────────────────────────────
	// password_required lives in common.ts.
	/** Password prompt message asking the user to type the password of a protected PDF or public link */
	enter_the_password: "Enter password",
	/** Error toast shown when a PDF file is corrupt or not a valid document */
	invalid_pdf: "This PDF could not be opened",
	/** Error toast shown when a PDF file could not be loaded from disk */
	unable_to_load_pdf: "Unable to load this PDF",
	/** Button shown after the user dismissed the password prompt — re-opens the prompt to enter the PDF password */
	enter_pdf_password: "Enter password",

	// ── Shared preview error states (previewText.tsx / previewDocx.tsx / previewPdf.tsx) ──────
	/** Error state body shown when a file preview failed to load */
	preview_load_failed: "Could not load this file",
	/** Button label to retry a failed file preview load */
	retry: "Retry",

	// ── Text preview (previewText.tsx) ─────────────────────────────────────────
	/** Placeholder shown in the text editor when the previewed file is empty */
	placeholder: "Empty",

	// ── Floating-bar audio slot (audioSlot.tsx) ────────────────────────────────
	// unknown_title and not_playing live in media.ts.

	// ── Public link route (publicLink/index.tsx) ───────────────────────────────
	/** Public-link screen header title */
	public_link: "Public link",
	/** Public-link metadata row label: when the link expires */
	expiration: "Expiration",
	/** Public-link toggle label: whether recipients are allowed to download the shared item */
	downloadable: "Downloadable",
	/** Public-link empty state title shown when no public link exists yet for this item */
	public_link_disabled: "No public link",
	/** Public-link empty state subtitle describing what enabling a public link does */
	public_link_description: "Create a link to share this item with anyone",
	/** Button that creates / turns on a public link for the item */
	enable_public_link: "Enable public link",
	/** Empty state title shown when public links require a paid plan the user doesn't have */
	feature_requires_subscription: "This feature requires a subscription",
	/** Empty state subtitle explaining that public links are a paid feature */
	feature_requires_subscription_public_links_description: "Upgrade your account to share items with public links",
	/** Public-link expiration option: the link never expires */
	never: "Never",
	// one_hour lives in common.ts.
	/** Public-link expiration option: 6 hours from now */
	six_hours: "6 hours",
	/** Public-link expiration option: 1 day from now */
	one_day: "1 day",
	/** Public-link expiration option: 3 days from now */
	three_days: "3 days",
	/** Public-link expiration option: 1 week from now */
	one_week: "1 week",
	/** Public-link expiration option: 2 weeks from now */
	two_weeks: "2 weeks",
	/** Public-link expiration option: 30 days from now */
	thirty_days: "30 days",
	/** Error shown when the public link could not be built for sharing */
	public_link_generate_failed: "Could not create the public link. Please try again.",
	/** Error shown when the device does not support the system share sheet */
	sharing_not_available: "Sharing is not available on this device.",

	// ── File versions route (fileVersions/index.tsx) ───────────────────────────
	/** File-versions screen header title (the history of past versions of a file) */
	file_versions: "File versions",
	/** File-versions empty state shown when the file has no previous versions */
	no_file_versions: "No file versions",
	/** Confirmation dialog title shown before restoring a single past file version */
	restore_version: "Restore version",
	/** Confirmation dialog message shown before restoring a single past file version */
	restore_version_confirmation: "Are you sure you want to restore this version?",
	/** Confirmation dialog title shown before deleting a single past file version */
	delete_version: "Delete version",
	/** Confirmation dialog message shown before deleting a single past file version */
	delete_version_confirmation: "Are you sure you want to delete this version?",
	/** Confirmation dialog message shown before deleting every selected file version */
	delete_selected_versions_confirmation: "Are you sure you want to delete the selected versions?",
	// delete_all lives in common.ts.
	/** Confirmation dialog title shown before deleting every past version of the file */
	delete_all_versions: "Delete all versions",
	/** Confirmation dialog message shown before deleting every past version of the file */
	delete_all_versions_confirmation: "Are you sure you want to delete all versions of this file?"
} as const
