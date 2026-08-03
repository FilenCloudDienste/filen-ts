import { createElement } from "react"
import { useTranslation } from "react-i18next"
import { XIcon } from "lucide-react"
import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"
import { type SelectedContacts } from "@/features/contacts/lib/selection"
import { buildContactBulkActions, type ContactBulkActionKind } from "@/features/contacts/components/contactsBulkBar.logic"
import { Kbd } from "@/lib/keymap/kbd"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export interface ContactsBulkBarProps {
	// The selection already resolved against the live records (resolveSelectedContacts) — the same value
	// the list gates this bar's mounting on, so the bar can never disagree with the gate about how many
	// of the selected rows still exist.
	selected: SelectedContacts
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
	selected,
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

	const descriptors = buildContactBulkActions({
		requests: selected.requests.length,
		pending: selected.pending.length,
		contacts: selected.contacts.length,
		blocked: selected.blocked.length
	})

	function run(kind: ContactBulkActionKind): void {
		switch (kind) {
			case "unblock":
				onUnblock(selected.blocked)
				return
			case "accept":
				onAccept(selected.requests)
				return
			case "deny":
				onDeny(selected.requests)
				return
			case "cancel":
				onCancel(selected.pending)
				return
			case "remove":
				onRemove(selected.contacts)
				return
			case "block":
				onBlock(selected.contacts)
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
				<p className="text-sm text-muted-foreground">{t("contactsSelectionCount", { count: selected.total })}</p>
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
