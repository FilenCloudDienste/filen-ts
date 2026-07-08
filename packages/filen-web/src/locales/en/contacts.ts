// English source catalog — "contacts" namespace: the contacts page (established contacts, blocked
// contacts, incoming/outgoing requests), the add-contact dialog, and every per-row/bulk action and
// confirm dialog contacts exposes. Same typed-catalog rules as common/errors/auth/drive: flat
// `as const` object, camelCase keys, no literal '.' or ':' (real i18next namespaces,
// keySeparator/nsSeparator both ON). `moduleContacts` (the icon-rail label) stays in "common" — not
// duplicated here.
//
// Every key below is declared ahead of the components that will render it, so no literal string
// lands in a contacts component later (the drive.ts convention). Wording mirrors filen-mobile's
// contacts feature (useContacts.query.ts consumers, contactsActions.ts, contactRow.tsx,
// contactsHeader.tsx) where an equivalent surface already exists there.
export const contacts = {
	// ── Section headers ──────────────────────────────────────────────────────
	/** Contacts page — section header for incoming contact requests */
	contactsSectionRequests: "Requests",
	/** Contacts page — section header for outgoing (sent, not yet accepted) contact requests */
	contactsSectionPending: "Pending",
	/** Contacts page — section header for established contacts */
	contactsSectionContacts: "Contacts",
	/** Contacts page — section header for blocked contacts */
	contactsSectionBlocked: "Blocked",

	// ── Empty states ─────────────────────────────────────────────────────────
	/** Contacts page — empty-state title when the user has no contacts yet */
	contactsEmptyTitle: "No contacts",
	/** Contacts page — empty-state body under contactsEmptyTitle */
	contactsEmptyBody: "Add a contact to start sharing and chatting.",
	/** Contacts page — empty-state title when there are no incoming or outgoing requests */
	contactsRequestsEmptyTitle: "No requests",
	/** Contacts page — empty-state body under contactsRequestsEmptyTitle */
	contactsRequestsEmptyBody: "Contact requests you send or receive will appear here.",
	/** Contacts page — title shown when the contacts/requests queries fail to load; the body is the failing query's own errorLabel */
	contactsLoadError: "Couldn't load contacts",

	// ── Search ───────────────────────────────────────────────────────────────
	/** Contacts page — search input placeholder */
	contactsSearchPlaceholder: "Search contacts",

	// ── Presence ─────────────────────────────────────────────────────────────
	/** Contact row — visually-hidden label announcing a contact's online-presence indicator */
	contactsPresenceOnline: "Online",

	// ── Add-contact dialog ───────────────────────────────────────────────────
	// contactsActionAdd doubles as the triggering action label (header/menu button) AND the
	// add-contact dialog's title AND its submit button — same triple reuse as driveActionRename in
	// locales/en/drive.ts.
	/** Add-contact action label; also the add-contact dialog's title and submit button */
	contactsActionAdd: "Add contact",
	/** Add-contact dialog — body prompting for the other person's Filen email address */
	contactsAddBody: "Enter the Filen email address of the person you want to add.",
	/** Add-contact dialog — email field label */
	contactsAddEmailLabel: "Email",
	/** Add-contact dialog — email field placeholder */
	contactsAddEmailPlaceholder: "you@example.com",
	/** Add-contact dialog — validation message shown when the typed address is not a valid email */
	contactsAddInvalidEmail: "Enter a valid email address",

	// ── Row / bulk action labels ─────────────────────────────────────────────
	// Imperative verbs, not state descriptions — same rule as drive.ts's item-menu entries. Each
	// confirm dialog below reuses the matching one of these as its own confirm button. Only Remove
	// and Block render as destructive (contactsRemoveConfirmTitle/contactsBlockConfirmTitle below);
	// Deny/Cancel/Unblock do not, despite filen-mobile flagging deny/cancel destructive too — Unblock
	// lifts a restriction (never destructive on either platform).
	/** Row/bulk action — accept an incoming contact request; no confirm dialog (mirrors mobile) */
	contactsActionAccept: "Accept",
	/** Row/bulk action — deny an incoming contact request; also the deny-confirm dialog's confirm button */
	contactsActionDeny: "Deny",
	/** Row/bulk action — cancel an outgoing (sent) contact request; also the cancel-confirm dialog's confirm button */
	contactsActionCancelRequest: "Cancel request",
	/** Row/bulk action — remove an established contact; also the remove-confirm dialog's confirm button; destructive */
	contactsActionRemove: "Remove",
	/** Row/bulk action — block a contact; also the block-confirm dialog's confirm button; destructive */
	contactsActionBlock: "Block",
	/** Row/bulk action — unblock a blocked contact; also the unblock-confirm dialog's confirm button */
	contactsActionUnblock: "Unblock",

	// ── Deny-request confirm ─────────────────────────────────────────────────
	/** Deny-request confirm dialog — title; the confirm button reuses contactsActionDeny */
	contactsDenyConfirmTitle: "Deny request?",
	/** Deny-request confirm dialog — body for a single request */
	contactsDenyConfirmBody_one: "Are you sure you want to deny this contact request?",
	/** Deny-request confirm dialog — body for multiple requests; {{count}} = requests being denied */
	contactsDenyConfirmBody_other: "Are you sure you want to deny these {{count}} contact requests?",

	// ── Cancel-request confirm ───────────────────────────────────────────────
	/** Cancel-request confirm dialog — title; the confirm button reuses contactsActionCancelRequest */
	contactsCancelConfirmTitle: "Cancel request?",
	/** Cancel-request confirm dialog — body for a single request */
	contactsCancelConfirmBody_one: "Are you sure you want to cancel this contact request?",
	/** Cancel-request confirm dialog — body for multiple requests; {{count}} = requests being cancelled */
	contactsCancelConfirmBody_other: "Are you sure you want to cancel these {{count}} contact requests?",

	// ── Remove-contact confirm (destructive) ─────────────────────────────────
	/** Remove-contact confirm dialog — title; the confirm button reuses contactsActionRemove */
	contactsRemoveConfirmTitle: "Remove contact?",
	/** Remove-contact confirm dialog — body for a single contact */
	contactsRemoveConfirmBody_one: "Are you sure you want to remove this contact?",
	/** Remove-contact confirm dialog — body for multiple contacts; {{count}} = contacts being removed */
	contactsRemoveConfirmBody_other: "Are you sure you want to remove these {{count}} contacts?",

	// ── Block-contact confirm (destructive) ──────────────────────────────────
	/** Block-contact confirm dialog — title; the confirm button reuses contactsActionBlock */
	contactsBlockConfirmTitle: "Block contact?",
	/** Block-contact confirm dialog — body for a single contact */
	contactsBlockConfirmBody_one: "Are you sure you want to block this contact?",
	/** Block-contact confirm dialog — body for multiple contacts; {{count}} = contacts being blocked */
	contactsBlockConfirmBody_other: "Are you sure you want to block these {{count}} contacts?",

	// ── Unblock-contact confirm ───────────────────────────────────────────────
	/** Unblock-contact confirm dialog — title; the confirm button reuses contactsActionUnblock */
	contactsUnblockConfirmTitle: "Unblock contact?",
	/** Unblock-contact confirm dialog — body for a single contact */
	contactsUnblockConfirmBody_one: "Are you sure you want to unblock this contact?",
	/** Unblock-contact confirm dialog — body for multiple contacts; {{count}} = contacts being unblocked */
	contactsUnblockConfirmBody_other: "Are you sure you want to unblock these {{count}} contacts?",

	// ── Bulk action result toast ─────────────────────────────────────────────
	// Generic across every bulk contact action (accept/deny/cancel/remove/block/unblock) rather than
	// one pair per action — same "partial success, every item runs independently" rationale as
	// driveBulkActionComplete_one/_other in locales/en/drive.ts.
	/** Bulk action result toast — every selected contact succeeded; {{count}} = contacts affected */
	contactsBulkActionComplete_one: "{{count}} contact updated",
	/** Bulk action result toast — every selected contact succeeded (plural); {{count}} = contacts affected */
	contactsBulkActionComplete_other: "{{count}} contacts updated",
	/** Bulk action result toast — at least one selected contact failed; {{count}} = contacts that succeeded, {{failed}} = contacts that failed */
	contactsBulkActionCompleteWithFailures_one: "{{count}} contact updated, {{failed}} failed",
	/** Bulk action result toast — at least one selected contact failed (plural); {{count}} = contacts that succeeded, {{failed}} = contacts that failed */
	contactsBulkActionCompleteWithFailures_other: "{{count}} contacts updated, {{failed}} failed"
} as const
