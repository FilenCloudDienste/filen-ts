// Contacts feature vocabulary (src/routes/contacts/index.tsx) and
// Incoming Share vocabulary (src/routes/incomingShare/index.tsx).
// Shared keys (cancel, remove, select, deselect, deselect_all, selected_one/other)
// live in common.ts and must not be redefined here.
//
// Bulk-action titles with counts embed {{count}} directly so the full label
// (e.g. "Unblock (3)") is one translatable unit — call t(key, { count }).
export const contacts = {
	// ── Screen / header ───────────────────────────────────────────────────────
	/** Contacts screen — header title when not in bulk-selection mode */
	contacts: "Contacts",
	/** Contacts search bar placeholder */
	search_contacts: "Search contacts",
	/** Empty-state label shown when the contacts list is empty */
	no_contacts: "No contacts",

	// ── Section headers ───────────────────────────────────────────────────────
	/** Section header for incoming (received) contact requests */
	contacts_requests: "Requests",
	/** Section header for outgoing (sent, still pending) contact requests */
	contacts_pending: "Pending",
	/** Section header listing accepted contacts */
	contact_contacts: "Contacts",
	/** Section header listing blocked users */
	contact_blocked: "Blocked",

	// ── Add contact ───────────────────────────────────────────────────────────
	/** Menu item and dialog title: add a new contact by email */
	add_contact: "Add contact",
	/** Dialog message prompting for the other person's Filen account email */
	enter_contact_filen_email: "Enter the Filen email address of the person you want to add",
	// add (the dialog OK button) lives in common.ts.

	// ── Per-row actions (individual contact menu) ─────────────────────────────
	/** Menu item: start or open a direct-message chat with this contact */
	message: "Message",
	/** Menu item: accept an incoming contact request */
	accept: "Accept",
	/** Menu item: deny an incoming contact request */
	deny: "Deny",
	/** Menu item: block a contact */
	block: "Block",
	/** Menu item: unblock a previously blocked contact */
	unblock: "Unblock",
	/** Menu item: cancel a sent (outgoing) contact request */
	cancel_request: "Cancel request",
	// remove (menu item / dialog title) lives in common.ts.

	// ── Single-item confirmation dialogs ──────────────────────────────────────
	/** Dialog title: confirm removing a specific contact */
	remove_contact: "Remove contact",
	/** Dialog message: confirm removing a specific contact */
	remove_contact_confirmation: "Are you sure you want to remove this contact?",

	/** Dialog title: confirm blocking a specific contact */
	block_contact: "Block contact",
	/** Dialog message: confirm blocking a specific contact */
	block_contact_confirmation: "Are you sure you want to block this contact?",

	/** Dialog title: confirm unblocking a specific blocked contact */
	unblock_contact: "Unblock contact",
	/** Dialog message: confirm unblocking a specific blocked contact */
	unblock_contact_confirmation: "Are you sure you want to unblock this contact?",

	/** Dialog title: confirm denying a specific incoming contact request */
	deny_request_contact: "Deny request",
	/** Dialog message: confirm denying a specific incoming contact request */
	deny_request_contact_confirmation: "Are you sure you want to deny this contact request?",
	/** Confirm button label in the deny-request dialog */
	deny_request: "Deny request",

	/** Dialog title: confirm denying a specific incoming contact request (alternative context — same action from inline button) */
	deny_contact: "Deny request",
	/** Dialog message: confirm denying a specific incoming contact request (alternative context) */
	deny_contact_confirmation: "Are you sure you want to deny this contact request?",

	/** Dialog title: confirm cancelling a sent (outgoing) contact request from the request row */
	cancel_request_contact: "Cancel request",
	/** Dialog message: confirm cancelling a sent (outgoing) contact request from the request row */
	cancel_request_contact_confirmation: "Are you sure you want to cancel this contact request?",

	/** Dialog title: confirm cancelling a sent (outgoing) contact request from the outgoing-row cancel button */
	cancel_contact: "Cancel request",
	/** Dialog message: confirm cancelling a sent (outgoing) contact request from the outgoing-row cancel button */
	cancel_contact_confirmation: "Are you sure you want to cancel this contact request?",

	// ── Bulk-action titles (include count; call t(key, { count })) ─────────────
	/** Bulk header menu item: unblock N selected blocked contacts. {{count}} is the selection count */
	bulk_unblock: "Unblock ({{count}})",
	/** Bulk header menu item: accept N selected incoming requests. {{count}} is the selection count */
	bulk_accept: "Accept ({{count}})",
	/** Bulk header menu item: remove N selected contacts. {{count}} is the selection count */
	bulk_remove: "Remove ({{count}})",
	/** Bulk header menu item: block N selected contacts. {{count}} is the selection count */
	bulk_block: "Block ({{count}})",
	/** Bulk header menu item: deny N selected incoming requests. {{count}} is the selection count */
	bulk_deny: "Deny ({{count}})",
	/** Bulk header menu item: cancel N selected outgoing requests. {{count}} is the selection count */
	bulk_cancel_request: "Cancel request ({{count}})",

	// ── Bulk confirmation dialogs ─────────────────────────────────────────────
	/** Bulk unblock confirm body */
	unblock_selected_confirmation: "Are you sure you want to unblock the selected contacts?",
	/** Bulk remove contacts confirm body */
	remove_selected_contacts_confirmation: "Are you sure you want to remove the selected contacts?",
	/** Bulk block contacts confirm body */
	block_selected_contacts_confirmation: "Are you sure you want to block the selected contacts?",
	/** Bulk deny incoming requests confirm body */
	deny_selected_requests_confirmation: "Are you sure you want to deny the selected contact requests?",
	/** Bulk cancel outgoing requests confirm body */
	cancel_selected_outgoing_confirmation: "Are you sure you want to cancel the selected contact requests?",

	// ── Incoming Share screen ─────────────────────────────────────────────────
	/** Incoming Share screen — header title */
	saved_shares: "Save to Filen",
	/** Empty-state label shown when the share extension returned an error while resolving shared files */
	error_resolving_shares: "Could not resolve the shared files",
	/** Empty-state label shown while waiting for the OS to finish resolving shared files */
	no_resolved_shares: "Waiting for shared files…",

	// ── Empty-state subtitles (ListEmpty descriptions) ────────────────────────
	/** Contacts — empty-state subtitle when no contacts exist yet */
	no_contacts_description: "Add a contact to start sharing and chatting.",
	/** Incoming share — error-state subtitle when the shared files could not be resolved */
	error_resolving_shares_description: "Please go back and try sharing again.",
	/** Incoming share — waiting-state subtitle while the OS resolves shared files */
	no_resolved_shares_description: "This should only take a moment."
} as const
