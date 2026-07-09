import { CheckIcon, XIcon, Trash2Icon, BanIcon, RotateCcwIcon, type LucideIcon } from "lucide-react"
import { type ContactsKey } from "@/lib/i18n"

export type ContactBulkActionKind = "unblock" | "accept" | "deny" | "cancel" | "remove" | "block"

export interface ContactBulkCounts {
	requests: number
	pending: number
	contacts: number
	blocked: number
}

export interface ContactBulkActionDescriptor {
	kind: ContactBulkActionKind
	count: number
	labelKey: ContactsKey
	icon: LucideIcon
	destructive?: boolean
}

// Pure gating builder for the contacts bulk-action bar — mirrors drive's bulkActionBar.logic.ts
// (a flat descriptor list built from aggregated counts, trivially testable without rendering
// anything). Fixed order mirrors filen-mobile's contactsHeader.tsx exactly: affirmative actions
// first (unblock, accept), then the less-harsh rejections (deny, cancel), then the destructive pair
// last (remove, block). A cross-section selection can surface descriptors from more than one group
// at once — unlike drive's single-item-type selection — so this fixed order is what keeps a mixed
// bar legible rather than an accident of iteration. Only remove/block are destructive (the locale
// catalog's own doc comments: deny/cancel/unblock are never destructive-styled, despite mobile
// flagging deny/cancel that way).
export function buildContactBulkActions(counts: ContactBulkCounts): ContactBulkActionDescriptor[] {
	const descriptors: ContactBulkActionDescriptor[] = []

	if (counts.blocked > 0) {
		descriptors.push({ kind: "unblock", count: counts.blocked, labelKey: "contactsActionUnblock", icon: RotateCcwIcon })
	}

	if (counts.requests > 0) {
		descriptors.push({ kind: "accept", count: counts.requests, labelKey: "contactsActionAccept", icon: CheckIcon })
		descriptors.push({ kind: "deny", count: counts.requests, labelKey: "contactsActionDeny", icon: XIcon })
	}

	if (counts.pending > 0) {
		descriptors.push({ kind: "cancel", count: counts.pending, labelKey: "contactsActionCancelRequest", icon: XIcon })
	}

	if (counts.contacts > 0) {
		descriptors.push({ kind: "remove", count: counts.contacts, labelKey: "contactsActionRemove", icon: Trash2Icon, destructive: true })
		descriptors.push({ kind: "block", count: counts.contacts, labelKey: "contactsActionBlock", icon: BanIcon, destructive: true })
	}

	return descriptors
}
