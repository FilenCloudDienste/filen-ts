import { type MouseEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, XIcon, MoreHorizontalIcon, RotateCcwIcon, MessagesSquareIcon } from "lucide-react"
import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"
import { ContactMenuContent } from "@/features/contacts/components/contactMenu"
import { UserAvatar } from "@/components/userAvatar"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn, contactDisplayName, type ContactLike } from "@filen/shared"
import { onActivateKey } from "@/lib/rowKeys"
import { useTouchLongPress } from "@/lib/useTouchLongPress"

export interface ContactRowProps {
	// Any contact-like record: a contact, an incoming/outgoing request or a blocked contact.
	contact: ContactLike & { avatar?: string | undefined }
	// Selection state, shared by both contracts below; meaningless without one of them.
	selected?: boolean | undefined
	// Contract A — bounded dialog picker (ContactPickerList): the row owns its own Enter/Space toggle and
	// is unconditionally tabbable. Correct where the list is short, fixed-height and its trailing slot
	// holds a glyph rather than controls.
	onToggleSelect?: (() => void) | undefined
	// Contract B — the contacts page's section listbox: the container owns key handling (it is the only
	// scope holding the section's uuid array), so the row takes a click handler, a roving cursor flag and
	// a ref instead of an onKeyDown. `active` is what makes this row the section's single Tab stop
	// (driveRow.tsx's identical rule).
	// `pointerType` is the one behind the click: a touch tap toggles. onLongPress is a held touch's toggle.
	onSelect?: ((event: MouseEvent<HTMLDivElement>, pointerType: string) => void) | undefined
	onLongPress?: (() => void) | undefined
	active?: boolean | undefined
	rowRef?: ((element: HTMLDivElement | null) => void) | undefined
	// Trailing slot: the per-row action buttons/menu (accept/deny, cancel, remove/block, unblock), or a
	// picker's non-interactive check glyph.
	children?: ReactNode
}

export function ContactRow({ contact, selected, onToggleSelect, onSelect, onLongPress, active, rowRef, children }: ContactRowProps) {
	const displayName = contactDisplayName(contact)
	const roving = onSelect !== undefined
	const selectable = roving || onToggleSelect !== undefined
	const press = useTouchLongPress<HTMLDivElement>({
		onLongPress: () => {
			onLongPress?.()
		}
	})

	// One Tab stop per section listbox under contract B, the row's own stop under contract A.
	function resolveTabIndex(): number | undefined {
		if (!selectable) {
			return undefined
		}

		if (!roving) {
			return 0
		}

		return active === true ? 0 : -1
	}

	return (
		<div
			ref={rowRef}
			role={selectable ? "option" : undefined}
			aria-selected={selectable ? selected === true : undefined}
			tabIndex={resolveTabIndex()}
			{...(roving ? press.handlers : {})}
			onClick={event => {
				if (onSelect !== undefined) {
					onSelect(event, press.pointerType(event))
				} else {
					onToggleSelect?.()
				}
			}}
			onKeyDown={onToggleSelect === undefined ? undefined : onActivateKey(onToggleSelect)}
			className={cn(
				"flex h-14 items-center gap-3 text-sm",
				// Contract B rows tile a rounded, hairline-divided panel (contactsList.tsx) — square, and ringed
				// inset so the panel's overflow clip cannot cut the focus ring. Everywhere else a row is its
				// own rounded pill.
				roving ? "group/row px-3 focus-visible:ring-inset" : "rounded-xl px-2",
				selectable
					? "focus-ring-row outline-none select-none not-aria-selected:hover:bg-accent/50 aria-selected:bg-accent aria-selected:text-accent-foreground"
					: "hover:bg-accent/50"
			)}
		>
			<UserAvatar
				src={contact.avatar}
				name={displayName}
			/>
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium">{displayName}</p>
				<p className="truncate text-xs text-muted-foreground">{contact.email}</p>
			</div>
			{roving ? (
				<div
					className="flex shrink-0 items-center gap-1.5"
					onClick={event => {
						// Acting on a row must not also select it — the same guard driveRow.tsx puts on its own
						// menu trigger, hoisted to the whole slot since contacts has four different ones. A
						// picker (contract A) must NOT get this: its slot holds a check glyph inside a row whose
						// entire surface is the toggle target.
						event.stopPropagation()
					}}
				>
					{children}
				</div>
			) : (
				children
			)}
		</div>
	)
}

// ── Per-row action slots ─────────────────────────────────────────────────
// Every component below only signals intent upward via callback props — none of them call an action
// helper or open a confirm dialog directly. contactsList.tsx's dialog host owns every confirm +
// mutation, mirroring drive's itemMenu.tsx (dialog-routed descriptors report a kind, the listing
// resolves it) — the one exception is Accept, which runs with no confirm (mirrors mobile), so it's
// still just a reported intent (the caller runs it immediately instead of opening a dialog).

export interface IncomingRequestActionsProps {
	request: ContactRequestIn
	onAccept: (request: ContactRequestIn) => void
	onDeny: (request: ContactRequestIn) => void
	disabled?: boolean
	// Set only when `disabled` is caused specifically by the app being offline — surfaced as each
	// button's native title.
	title?: string | undefined
	// Only the cursor row's controls join the normal Tab sequence (driveRow.tsx's own rule) — otherwise
	// every visible row would add its own Tab stops to an unvirtualized list.
	tabIndex?: number
}

export function IncomingRequestActions({ request, onAccept, onDeny, disabled, title, tabIndex }: IncomingRequestActionsProps) {
	const { t } = useTranslation("contacts")

	return (
		<>
			<Button
				size="sm"
				disabled={disabled}
				title={title}
				tabIndex={tabIndex}
				onClick={() => {
					onAccept(request)
				}}
			>
				<CheckIcon aria-hidden="true" />
				{t("contactsActionAccept")}
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				disabled={disabled}
				aria-label={t("contactsActionDeny")}
				title={title ?? t("contactsActionDeny")}
				tabIndex={tabIndex}
				onClick={() => {
					onDeny(request)
				}}
			>
				<XIcon aria-hidden="true" />
			</Button>
		</>
	)
}

export interface OutgoingRequestActionsProps {
	request: ContactRequestOut
	onCancel: (request: ContactRequestOut) => void
	disabled?: boolean
	title?: string | undefined
	tabIndex?: number
}

export function OutgoingRequestActions({ request, onCancel, disabled, title, tabIndex }: OutgoingRequestActionsProps) {
	const { t } = useTranslation("contacts")

	return (
		<Button
			variant="outline"
			size="sm"
			disabled={disabled}
			title={title}
			tabIndex={tabIndex}
			onClick={() => {
				onCancel(request)
			}}
		>
			<XIcon aria-hidden="true" />
			{t("contactsActionCancelRequest")}
		</Button>
	)
}

export interface ContactActionsProps {
	contact: Contact
	onMessage: (contact: Contact) => void
	onRemove: (contact: Contact) => void
	onBlock: (contact: Contact) => void
	disabled?: boolean
	// Set only when `disabled` is caused specifically by the app being offline — threaded to
	// ContactMenuContent's own items (the trigger itself always opens the menu, never disabled).
	title?: string | undefined
	tabIndex?: number
}

// Message is a contact row's everyday action, so it sits beside the ⋯ menu (which still lists it, for
// keyboard and context parity). Both reveal with the row — hover, keyboard focus, selection or an open
// menu — the same quiet-until-wanted treatment as driveRow.tsx's ⋯ trigger; a coarse pointer cannot
// hover, so there they always show. Revealed as one group so a disabled button's own opacity stays
// relative to it instead of outranking the hidden state.
//
// DropdownMenu Root > Trigger + Content, mirroring driveRow.tsx's exact nesting for its own ⋯
// dropdown: Trigger is a render-prop'd Button (not a child), Content (ContactMenuContent, which
// already wraps Portal>Positioner>Popup) is the Root's other direct child.
export function ContactActions({ contact, onMessage, onRemove, onBlock, disabled, title, tabIndex }: ContactActionsProps) {
	const { t } = useTranslation("contacts")

	return (
		<div className="flex items-center gap-1 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 group-aria-selected/row:opacity-100 has-aria-expanded:opacity-100 pointer-coarse:opacity-100">
			<Button
				variant="ghost"
				size="sm"
				disabled={disabled}
				title={title}
				tabIndex={tabIndex}
				onClick={() => {
					onMessage(contact)
				}}
			>
				<MessagesSquareIcon aria-hidden="true" />
				{t("contactsActionMessage")}
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={t("contactsRowMenuTrigger")}
							tabIndex={tabIndex}
						>
							<MoreHorizontalIcon aria-hidden="true" />
						</Button>
					}
				/>
				<ContactMenuContent
					contact={contact}
					onMessage={onMessage}
					onRemove={onRemove}
					onBlock={onBlock}
					disabled={disabled}
					title={title}
				/>
			</DropdownMenu>
		</div>
	)
}

export interface BlockedActionsProps {
	contact: BlockedContact
	onUnblock: (contact: BlockedContact) => void
	disabled?: boolean
	title?: string | undefined
	tabIndex?: number
}

export function BlockedActions({ contact, onUnblock, disabled, title, tabIndex }: BlockedActionsProps) {
	const { t } = useTranslation("contacts")

	return (
		<Button
			variant="outline"
			size="sm"
			disabled={disabled}
			title={title}
			tabIndex={tabIndex}
			onClick={() => {
				onUnblock(contact)
			}}
		>
			<RotateCcwIcon aria-hidden="true" />
			{t("contactsActionUnblock")}
		</Button>
	)
}
