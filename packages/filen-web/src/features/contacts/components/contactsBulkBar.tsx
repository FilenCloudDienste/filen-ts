import { createElement } from "react"
import { useTranslation } from "react-i18next"
import { XIcon } from "lucide-react"
import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"
import { type ContactSelection } from "@/features/contacts/lib/selection"
import { buildContactBulkActions, type ContactBulkActionKind } from "@/features/contacts/components/contactsBulkBar.logic"
import { Kbd } from "@/lib/keymap/kbd"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export interface ContactsBulkBarProps {
	// The current (unfiltered) query data per section — the bar filters these by uuid, so a selection
	// made before a search still resolves to the right records even though the rows behind this bar are
	// search-filtered (same semantics as notesSidebar.tsx's liveSelectedNotes, derived from allNotes).
	requests: ContactRequestIn[]
	pending: ContactRequestOut[]
	contacts: Contact[]
	blocked: BlockedContact[]
	selection: ContactSelection
	onClear: () => void
	// Direct — no confirm (mirrors mobile: accept never confirms).
	onAccept: (items: ContactRequestIn[]) => void
	// The rest only signal intent upward — contactsList.tsx's dialog host owns the confirm + the
	// actual mutation, same split as the per-row actions in contactRow.tsx.
	onDeny: (items: ContactRequestIn[]) => void
	onCancel: (items: ContactRequestOut[]) => void
	onRemove: (items: Contact[]) => void
	onBlock: (items: Contact[]) => void
	onUnblock: (items: BlockedContact[]) => void
	disabled?: boolean
	// Set only when `disabled` is caused specifically by the app being offline — surfaced as each
	// action button's native title.
	title?: string | undefined
}

// Bottom-anchored floating selection bar (contactsList.tsx overlays it on the list while a 2+
// selection exists) — mirrors drive/bulkActionBar.tsx's pill and its two-flex-child shape (clear+count
// on the left, actions on the right), plus its "compute selected items from a selection set, gate the
// descriptor list, dispatch by kind" structure.
export function ContactsBulkBar({
	requests,
	pending,
	contacts,
	blocked,
	selection,
	onClear,
	onAccept,
	onDeny,
	onCancel,
	onRemove,
	onBlock,
	onUnblock,
	disabled,
	title
}: ContactsBulkBarProps) {
	const { t } = useTranslation("contacts")

	const selectedRequests = requests.filter(request => selection.requests.has(request.uuid))
	const selectedPending = pending.filter(request => selection.pending.has(request.uuid))
	const selectedContacts = contacts.filter(contact => selection.contacts.has(contact.uuid))
	const selectedBlocked = blocked.filter(contact => selection.blocked.has(contact.uuid))
	const total = selectedRequests.length + selectedPending.length + selectedContacts.length + selectedBlocked.length

	const descriptors = buildContactBulkActions({
		requests: selectedRequests.length,
		pending: selectedPending.length,
		contacts: selectedContacts.length,
		blocked: selectedBlocked.length
	})

	function run(kind: ContactBulkActionKind): void {
		switch (kind) {
			case "unblock":
				onUnblock(selectedBlocked)
				return
			case "accept":
				onAccept(selectedRequests)
				return
			case "deny":
				onDeny(selectedRequests)
				return
			case "cancel":
				onCancel(selectedPending)
				return
			case "remove":
				onRemove(selectedContacts)
				return
			case "block":
				onBlock(selectedContacts)
				return
		}
	}

	return (
		<div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-popover px-3 py-2 text-popover-foreground shadow-lg">
			<div className="flex items-center gap-2">
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={t("contactsCommandClearSelection")}
								onClick={onClear}
							>
								<XIcon />
							</Button>
						}
					/>
					<TooltipContent>
						{t("contactsCommandClearSelection")}
						<Kbd action="contacts.clearSelection" />
					</TooltipContent>
				</Tooltip>
				<p className="text-sm text-muted-foreground">{t("contactsSelectionCount", { count: total })}</p>
			</div>
			<div className="flex items-center gap-2">
				{descriptors.map(descriptor => (
					<Button
						key={descriptor.kind}
						variant={descriptor.destructive ? "destructive" : "outline"}
						size="sm"
						disabled={disabled}
						title={title}
						onClick={() => {
							run(descriptor.kind)
						}}
					>
						{createElement(descriptor.icon, { "aria-hidden": true })}
						{t(descriptor.labelKey)} ({descriptor.count})
					</Button>
				))}
			</div>
		</div>
	)
}
