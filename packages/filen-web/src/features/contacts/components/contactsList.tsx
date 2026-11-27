import { useRef, useState, type MouseEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { SearchIcon, UsersIcon } from "lucide-react"
import { toast } from "sonner"
import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"
import { useContactsQuery, useContactRequestsQuery } from "@/features/contacts/queries/contacts"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useDialogHost } from "@/lib/useDialogHost"
import { useIsOnline } from "@/lib/useIsOnline"
import { blockingQueryError } from "@/queries/blockingError"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
import {
	buildContactSections,
	filterContactSections,
	CONTACTS_SECTION_FILTERS,
	CONTACTS_SECTION_HEADER_KEY,
	type ContactsSectionFilter
} from "@/features/contacts/components/contactsList.logic"
import {
	acceptRequest,
	denyRequest,
	cancelRequest,
	removeContact,
	blockContact,
	unblockContact,
	messageContact,
	type VoidActionOutcome
} from "@/features/contacts/lib/actions"
import { runBulkOutcomes } from "@/lib/actions/bulk"
import { runBulkActivity } from "@/lib/activity/activity"
import { type ActivityKeys } from "@/lib/activity/activity.logic"
import { singleOrCountKey } from "@/lib/i18n"
import {
	CONTACTS_ACCEPT,
	CONTACTS_BLOCK,
	CONTACTS_CANCEL_REQUEST,
	CONTACTS_DENY,
	CONTACTS_REMOVE,
	CONTACTS_UNBLOCK
} from "@/features/contacts/lib/activity"
import { contactCommandTargets, resolveSelectedContacts, type ContactSectionKey } from "@/features/contacts/lib/selection"
import { useContactsListSelection } from "@/features/contacts/hooks/useContactsListSelection"
import { useInFlightKeys } from "@/features/contacts/hooks/useInFlightKeys"
import {
	ContactRow,
	IncomingRequestActions,
	OutgoingRequestActions,
	ContactActions,
	BlockedActions
} from "@/features/contacts/components/contactRow"
import { AddContactDialog } from "@/features/contacts/components/addContactDialog"
import { ContactsBulkBar } from "@/features/contacts/components/contactsBulkBar"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loadingState"
import { BULK_BAR_MIN_SELECTION } from "@/components/selectionActionBar"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { contactDisplayName, type ContactLike } from "@filen/shared"
import { ContactSectionsList, type ContactSectionView } from "@/features/contacts/components/contactSectionsList"

// Room below the last row for the floating bulk bar (pb-16), or the list's own pb-6.
const BULK_BAR_PADDING = 64
const LIST_PADDING_BOTTOM = 24

// The per-kind dialog payload threaded through useDialogHost, widened with a `bulk` flag: every kind
// here can be reached either from a single row's own action (bulk: false, a 1-length items array) or
// from the bulk bar (bulk: true, the whole gated section selection) — same dialog, same title/body
// (the count just interpolates), only the confirm handler's run-single-vs-run-bulk branch differs.
// Accept has no dialog kind: it never confirms (mirrors mobile), so it never reaches this host.
type ActiveContactDialog =
	| { kind: "deny"; bulk: boolean; items: ContactRequestIn[] }
	| { kind: "cancel"; bulk: boolean; items: ContactRequestOut[] }
	| { kind: "remove"; bulk: boolean; items: Contact[] }
	| { kind: "block"; bulk: boolean; items: Contact[] }
	| { kind: "unblock"; bulk: boolean; items: BlockedContact[] }

// Owns both contacts queries, the search box's local state, bulk-selection mode, and the whole
// status-branch (loading / load-error / empty / sectioned list) — mirrors DirectoryListing's
// own self-contained shape (route files stay thin; the content component owns its data + its dialog
// host). `section` is owned by the route (its `section` path param, see
// routes/_app/contacts.$section.tsx) — the sidebar and this page are siblings under appShell, not
// parent/child, so the URL is their one shared source of truth for which section is active.
export function ContactsList({ section }: { section: ContactsSectionFilter }) {
	const { t } = useTranslation(["contacts", "common"])
	const navigate = useNavigate()
	const isOnline = useIsOnline()
	// Offline is the one disabled reason worth telling (an accept in flight clears itself a moment
	// later), so this single string is the "why" — computed once rather than re-deriving
	// `t("common:offlineActionDisabled")` at each of the 6 call sites below.
	const offlineTitle = !isOnline ? t("common:offlineActionDisabled") : undefined
	const [search, setSearch] = useState("")
	const searchRef = useRef<HTMLInputElement | null>(null)
	// The virtualized list's scroll-into-view, set by it once mounted: the arrow keys reveal a row outside its window.
	const revealRef = useRef<((key: ContactSectionKey, index: number) => void) | null>(null)
	const selection = useContactsListSelection({
		resetKey: section,
		revealRow: (key, index) => {
			revealRef.current?.(key, index)
		}
	})
	const { activeDialog, setActiveDialog, dialogPending, closeActiveDialog, runDialogOutcome, runBulkDialogActivity } =
		useDialogHost<ActiveContactDialog>()
	// Accept has no confirm dialog to carry a pending state, and its row stays until the op resolves: a
	// second click meanwhile would send a duplicate accept for a request the first is consuming.
	const accepting = useInFlightKeys()

	const contactsQuery = useContactsQuery()
	const requestsQuery = useContactRequestsQuery()

	const isPending = contactsQuery.status === "pending" || requestsQuery.status === "pending"
	// Either query can fail independently — check contacts first, requests second; a retry always
	// refetches both regardless of which one is shown, so which one "wins" the display only affects the
	// error copy. A failed background refresh of loaded data never replaces the list.
	const queryError = blockingQueryError(contactsQuery) ?? blockingQueryError(requestsQuery)

	const contactsData = contactsQuery.data?.contacts ?? []
	const blockedData = contactsQuery.data?.blocked ?? []
	const incomingData = requestsQuery.data?.incoming ?? []
	const outgoingData = requestsQuery.data?.outgoing ?? []

	// search-filtered, every section — the base every the sidebar's "all" view renders, and also what
	// tells the empty branch below whether the account genuinely has nothing (searchedSections empty
	// too) or just nothing in the CURRENTLY selected section (searchedSections non-empty, but the
	// section-narrowed `sections` below is).
	const searchedSections = buildContactSections({
		contacts: contactsData,
		blocked: blockedData,
		incoming: incomingData,
		outgoing: outgoingData,
		search
	})
	const sections = filterContactSections(searchedSections, section)
	// Gated on the LIVE resolved selection, never on the raw uuid count: a row acted on through its own
	// controls leaves the query data immediately, and a bar mounted on stale uuids renders as an empty
	// pill with no actions floating over the list.
	const selected = resolveSelectedContacts(
		{ requests: incomingData, pending: outgoingData, contacts: contactsData, blocked: blockedData },
		selection.selection
	)

	function handleRetry(): void {
		void contactsQuery.refetch()
		void requestsQuery.refetch()
	}

	// Def in features/contacts/lib/keymap.ts. No preventDefault — bare Escape has no disruptive browser default.
	// Guarded through the shared DOM-level dialog and menu signal rather than this host's own isDialogOpen:
	// AddContactDialog owns its own open state outside the host, and Escape must close whichever dialog
	// or menu is up without also clearing the selection behind it.
	useAction(
		"contacts.clearSelection",
		() => {
			selection.clearSelection()
		},
		OUTSIDE_OVERLAYS,
		[selection]
	)

	// Defs in features/contacts/lib/keymap.ts. Every one stands down under an open dialog or menu (OUTSIDE_OVERLAYS),
	// and the row commands are gated like the row controls they stand for: offline (and an accept already in flight)
	// does nothing.
	useAction(
		"contacts.selectAll",
		event => {
			event.preventDefault()
			selection.selectAll(sections.map(entry => ({ key: entry.key, uuids: entry.items.map(item => item.uuid) })))
		},
		OUTSIDE_OVERLAYS,
		[sections, selection]
	)

	useAction(
		"contacts.search",
		event => {
			event.preventDefault()
			searchRef.current?.focus()
		},
		OUTSIDE_OVERLAYS
	)

	useAction(
		"contacts.message",
		event => {
			const [contact, ...rest] = contactCommandTargets(
				"contacts",
				selected.total,
				selection.focusedRow(),
				contactsData,
				selected.contacts
			)

			if (contact === undefined || rest.length > 0 || !isOnline) {
				return
			}

			event.preventDefault()
			void handleMessage(contact)
		},
		OUTSIDE_OVERLAYS,
		[selected, contactsData, isOnline, selection]
	)

	// preventDefault: Backspace still has a "go back" default in some engines.
	useAction(
		"contacts.remove",
		event => {
			event.preventDefault()

			const items = contactCommandTargets("contacts", selected.total, selection.focusedRow(), contactsData, selected.contacts)

			if (items.length > 0 && isOnline) {
				setActiveDialog({ kind: "remove", bulk: items.length > 1, items })
			}
		},
		OUTSIDE_OVERLAYS,
		[selected, contactsData, isOnline, selection]
	)

	useAction(
		"contacts.block",
		() => {
			const items = contactCommandTargets("contacts", selected.total, selection.focusedRow(), contactsData, selected.contacts)

			if (items.length > 0 && isOnline) {
				setActiveDialog({ kind: "block", bulk: items.length > 1, items })
			}
		},
		OUTSIDE_OVERLAYS,
		[selected, contactsData, isOnline, selection]
	)

	useAction(
		"contacts.accept",
		() => {
			const items = contactCommandTargets("requests", selected.total, selection.focusedRow(), incomingData, selected.requests)

			if (items.length > 0 && isOnline) {
				handleAccept(items)
			}
		},
		OUTSIDE_OVERLAYS,
		[selected, incomingData, isOnline, selection]
	)

	useAction(
		"contacts.deny",
		() => {
			const items = contactCommandTargets("requests", selected.total, selection.focusedRow(), incomingData, selected.requests)

			if (items.length > 0 && isOnline) {
				setActiveDialog({ kind: "deny", bulk: items.length > 1, items })
			}
		},
		OUTSIDE_OVERLAYS,
		[selected, incomingData, isOnline, selection]
	)

	function showSection(step: 1 | -1): void {
		const next = CONTACTS_SECTION_FILTERS[CONTACTS_SECTION_FILTERS.indexOf(section) + step]

		if (next !== undefined) {
			void navigate({ to: "/contacts/$section", params: { section: next } })
		}
	}

	useAction(
		"contacts.nextSection",
		() => {
			showSection(1)
		},
		OUTSIDE_OVERLAYS,
		[section]
	)

	useAction(
		"contacts.previousSection",
		() => {
			showSection(-1)
		},
		OUTSIDE_OVERLAYS,
		[section]
	)

	// No confirm (mirrors mobile): one request from its row or several from the bar, as an activity. Its
	// requests stay claimed while it runs, and a Try again from its result claims the ones it re-runs,
	// skipping any a newer accept has taken meanwhile.
	function handleAccept(requests: ContactRequestIn[]): void {
		const claimed = new Set(accepting.claim(requests.map(request => request.uuid)))

		if (claimed.size === 0) {
			return
		}

		let heldByCaller = true

		void runBulkActivity({
			items: requests.filter(request => claimed.has(request.uuid)),
			keys: CONTACTS_ACCEPT,
			name: contactDisplayName,
			run: async (targets, onSettled) => {
				const own = heldByCaller ? new Set(claimed) : new Set(accepting.claim(targets.map(request => request.uuid)))

				heldByCaller = false

				const outcome = await runBulkOutcomes(
					targets.filter(request => own.has(request.uuid)),
					request => acceptRequest(request.uuid),
					onSettled
				)

				accepting.release([...own])

				return outcome
			},
			onDone: outcome => {
				selection.pruneSelection(
					"requests",
					outcome.succeeded.map(request => request.uuid)
				)
			}
		})
	}

	// Row menu "Message": creates-or-opens a 1:1 chat with the contact, then navigates straight into
	// it — no confirm (mirrors mobile's own one-click row handler), LABEL-FIRST toast on failure,
	// matching every other singular contact action's convention.
	async function handleMessage(contact: Contact): Promise<void> {
		const outcome = await messageContact(contact, {
			onChatReady: chat => {
				void navigate({ to: "/chats/$uuid", params: { uuid: chat.uuid } })
			}
		})

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	// Shared tail for a per-row single confirm: run the singular action helper, close silently on
	// success, toast + stay open (so the user can retry) on failure — mirrors directoryListing.tsx's
	// rename handler, the closest single-item (non-bulk-shaped) precedent there. Prunes on success for
	// the same reason the bulk tail does: rows stay selectable while their own controls are usable, so a
	// selected row can be acted on individually and must then leave the selection with it.
	async function runSingleDialogAction<T extends { uuid: string }>(
		section: ContactSectionKey,
		item: T,
		op: (item: T) => Promise<VoidActionOutcome>
	): Promise<void> {
		if (await runDialogOutcome(() => op(item))) {
			selection.pruneSelection(section, [item.uuid])
		}
	}

	// Shared tail for a bulk confirm: every item runs independently as an activity (useDialogHost's
	// runBulkDialogActivity), and the succeeded uuids leave the selection.
	async function runBulkDialogAction<T extends ContactLike & { uuid: string }>(
		section: ContactSectionKey,
		items: T[],
		keys: ActivityKeys,
		op: (item: T) => Promise<VoidActionOutcome>
	): Promise<void> {
		await runBulkDialogActivity({
			items,
			keys,
			name: contactDisplayName,
			run: (targets, onSettled) => runBulkOutcomes(targets, op, onSettled),
			onDone: outcome => {
				selection.pruneSelection(
					section,
					outcome.succeeded.map(item => item.uuid)
				)
			}
		})
	}

	// Generic over the item type so each switch case below keeps its own narrowed `items`.
	function renderConfirm<T extends ContactLike & { uuid: string }>(spec: {
		title: string
		body: string
		confirmLabel: string
		cancelLabel?: string
		destructive?: boolean
		section: ContactSectionKey
		keys: ActivityKeys
		items: T[]
		bulk: boolean
		op: (item: T) => Promise<VoidActionOutcome>
	}): ReactNode {
		return (
			<ConfirmDialog
				open
				pending={dialogPending}
				title={spec.title}
				body={spec.body}
				confirmLabel={spec.confirmLabel}
				cancelLabel={spec.cancelLabel ?? t("common:cancel")}
				destructive={spec.destructive ?? false}
				onOpenChange={open => {
					if (!open) {
						closeActiveDialog()
					}
				}}
				onConfirm={() => {
					if (spec.bulk) {
						void runBulkDialogAction(spec.section, spec.items, spec.keys, spec.op)
						return
					}

					const item = spec.items[0]

					if (!item) {
						return
					}

					void runSingleDialogAction(spec.section, item, spec.op)
				}}
			/>
		)
	}

	// One instance of whichever dialog is active, switching on activeDialog.kind — never more than one
	// mounted at a time. Only remove/block render `destructive` (the locale catalog's own doc
	// comments: deny/cancel/unblock never are, despite mobile flagging deny/cancel that way).
	function renderActiveDialog(): ReactNode {
		if (!activeDialog) {
			return null
		}

		const count = activeDialog.items.length

		switch (activeDialog.kind) {
			case "deny":
				return renderConfirm({
					title: t("contactsDenyConfirmTitle"),
					body: t(singleOrCountKey(count, "contactsDenyConfirmBodySingle", "contactsDenyConfirmBody"), { count }),
					confirmLabel: t("contactsActionDeny"),
					section: "requests",
					keys: CONTACTS_DENY,
					items: activeDialog.items,
					bulk: activeDialog.bulk,
					op: request => denyRequest(request.uuid)
				})
			case "cancel":
				return renderConfirm({
					title: t("contactsCancelConfirmTitle"),
					body: t(singleOrCountKey(count, "contactsCancelConfirmBodySingle", "contactsCancelConfirmBody"), { count }),
					confirmLabel: t("contactsActionCancelRequest"),
					cancelLabel: t("contactsCancelKeep"),
					section: "pending",
					keys: CONTACTS_CANCEL_REQUEST,
					items: activeDialog.items,
					bulk: activeDialog.bulk,
					op: request => cancelRequest(request.uuid)
				})
			case "remove":
				return renderConfirm({
					title: t("contactsRemoveConfirmTitle"),
					body: t(singleOrCountKey(count, "contactsRemoveConfirmBodySingle", "contactsRemoveConfirmBody"), { count }),
					confirmLabel: t("contactsActionRemove"),
					destructive: true,
					section: "contacts",
					keys: CONTACTS_REMOVE,
					items: activeDialog.items,
					bulk: activeDialog.bulk,
					op: contact => removeContact(contact.uuid)
				})
			case "block":
				return renderConfirm({
					title: t("contactsBlockConfirmTitle"),
					body: t(singleOrCountKey(count, "contactsBlockConfirmBodySingle", "contactsBlockConfirmBody"), { count }),
					confirmLabel: t("contactsActionBlock"),
					destructive: true,
					section: "contacts",
					keys: CONTACTS_BLOCK,
					items: activeDialog.items,
					bulk: activeDialog.bulk,
					op: contact => blockContact(contact)
				})
			case "unblock":
				return renderConfirm({
					title: t("contactsUnblockConfirmTitle"),
					body: t(singleOrCountKey(count, "contactsUnblockConfirmBodySingle", "contactsUnblockConfirmBody"), { count }),
					confirmLabel: t("contactsActionUnblock"),
					section: "blocked",
					keys: CONTACTS_UNBLOCK,
					items: activeDialog.items,
					bulk: activeDialog.bulk,
					op: contact => unblockContact(contact.uuid)
				})
		}
	}

	// One row of a section, dispatched on the section's own key — the key already discriminates `items`'
	// concrete type (see contactsList.logic.ts's ContactSection), so no per-item type tag is needed the way
	// mobile's flat single-list rendering requires one. Every row is permanently a listbox option AND
	// permanently shows its own actions; only the cursor row (and its controls) is tabbable, so the
	// section's Tab cost stays 1 regardless of how many contacts an account has.
	function renderRow(view: ContactSectionView, index: number, active: boolean): ReactNode {
		const { section: contactSection, uuids } = view
		const key = contactSection.key
		const uuid = uuids[index]

		if (uuid === undefined) {
			return null
		}

		const rowProps = {
			selected: selection.selection[key].has(uuid),
			active,
			posInSet: index + 1,
			setSize: uuids.length,
			rowRef: (element: HTMLDivElement | null) => {
				selection.registerRowRef(key, uuid, element)
			},
			onSelect: (event: MouseEvent<HTMLDivElement>, pointerType: string) => {
				selection.handlePointerSelect(key, uuids, index, event, pointerType)
			},
			onLongPress: () => {
				selection.toggleAt(key, uuids, index)
			}
		}
		const tabIndex = active ? 0 : -1

		switch (contactSection.key) {
			case "requests": {
				const request = contactSection.items[index]

				return request === undefined ? null : (
					<ContactRow
						contact={request}
						{...rowProps}
					>
						<IncomingRequestActions
							request={request}
							disabled={!isOnline || accepting.inFlight.has(request.uuid)}
							title={offlineTitle}
							tabIndex={tabIndex}
							onAccept={item => {
								handleAccept([item])
							}}
							onDeny={item => {
								setActiveDialog({ kind: "deny", bulk: false, items: [item] })
							}}
						/>
					</ContactRow>
				)
			}
			case "pending": {
				const request = contactSection.items[index]

				return request === undefined ? null : (
					<ContactRow
						contact={request}
						{...rowProps}
					>
						<OutgoingRequestActions
							request={request}
							disabled={!isOnline}
							title={offlineTitle}
							tabIndex={tabIndex}
							onCancel={item => {
								setActiveDialog({ kind: "cancel", bulk: false, items: [item] })
							}}
						/>
					</ContactRow>
				)
			}
			case "contacts": {
				const contact = contactSection.items[index]

				return contact === undefined ? null : (
					<ContactRow
						contact={contact}
						{...rowProps}
					>
						<ContactActions
							contact={contact}
							disabled={!isOnline}
							title={offlineTitle}
							tabIndex={tabIndex}
							onMessage={item => {
								void handleMessage(item)
							}}
							onRemove={item => {
								setActiveDialog({ kind: "remove", bulk: false, items: [item] })
							}}
							onBlock={item => {
								setActiveDialog({ kind: "block", bulk: false, items: [item] })
							}}
						/>
					</ContactRow>
				)
			}
			case "blocked": {
				const blocked = contactSection.items[index]

				return blocked === undefined ? null : (
					<ContactRow
						contact={blocked}
						{...rowProps}
					>
						<BlockedActions
							contact={blocked}
							disabled={!isOnline}
							title={offlineTitle}
							tabIndex={tabIndex}
							onUnblock={item => {
								setActiveDialog({ kind: "unblock", bulk: false, items: [item] })
							}}
						/>
					</ContactRow>
				)
			}
		}
	}

	// "all" stacks every section, so each one carries its own heading: incoming requests as a tinted
	// callout (they wait on the reader), the rest as a quiet labelled group. A single-section view is
	// already named by the page's <h1>, so it gets the bare panel.
	const sectionViews: ContactSectionView[] = sections.map(contactSection => {
		const label = t(CONTACTS_SECTION_HEADER_KEY[contactSection.key])
		const callout = section === "all" && contactSection.key === "requests"

		return {
			section: contactSection,
			uuids: contactSection.items.map(item => item.uuid),
			label,
			callout,
			heading:
				section !== "all"
					? null
					: callout
						? t("contactsRequestsCalloutTitle", { count: contactSection.items.length })
						: t("contactsSectionHeading", { section: label, count: contactSection.items.length })
		}
	})

	const searching = search.trim().length > 0

	return (
		<>
			{/* Header, search and list share one centred column; the scroller itself stays full-width so its
			scrollbar sits at the pane's edge rather than the column's. */}
			<header className="flex h-14 shrink-0 items-center px-4 app-region-chrome">
				<div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4">
					<h1 className="truncate text-sm font-medium">
						{section === "all" ? t("common:moduleContacts") : t(CONTACTS_SECTION_HEADER_KEY[section])}
					</h1>
					<AddContactDialog shortcut />
				</div>
			</header>
			<div className="shrink-0 px-4 pb-4">
				<div className="relative mx-auto w-full max-w-3xl">
					<SearchIcon
						aria-hidden="true"
						className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						ref={searchRef}
						type="search"
						aria-label={t("contactsSearchPlaceholder")}
						placeholder={t("contactsSearchPlaceholder")}
						value={search}
						onChange={event => {
							setSearch(event.target.value)
						}}
						className="h-9 pl-9"
					/>
				</div>
			</div>
			<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
				{/* Bottom-anchored floating selection bar — overlays the list, replacing nothing in the
				toolbar. Mirrors notesSidebar.tsx / directoryListing.tsx placement. */}
				{selected.total >= BULK_BAR_MIN_SELECTION ? (
					<div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex justify-center">
						<ContactsBulkBar
							selected={selected}
							disabled={!isOnline}
							title={offlineTitle}
							onClear={selection.clearSelection}
							onAccept={handleAccept}
							onDeny={items => {
								setActiveDialog({ kind: "deny", bulk: true, items })
							}}
							onCancel={items => {
								setActiveDialog({ kind: "cancel", bulk: true, items })
							}}
							onRemove={items => {
								setActiveDialog({ kind: "remove", bulk: true, items })
							}}
							onBlock={items => {
								setActiveDialog({ kind: "block", bulk: true, items })
							}}
							onUnblock={items => {
								setActiveDialog({ kind: "unblock", bulk: true, items })
							}}
						/>
					</div>
				) : null}
				{isPending ? (
					<LoadingState size="md" />
				) : queryError !== null ? (
					<div className="flex flex-1 overflow-y-auto">
						{/* Assertive: this replaces the spinner the reader was waiting on, and it carries the
						retry they need. Same treatment as drive's EmptyState error variant. */}
						<Empty role="alert">
							<EmptyHeader>
								<EmptyMedia>
									<UsersIcon />
								</EmptyMedia>
								<EmptyTitle>{t("contactsLoadError")}</EmptyTitle>
								<EmptyDescription>{errorLabel(queryError)}</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
								<Button
									variant="outline"
									onClick={handleRetry}
								>
									{t("common:tryAgain")}
								</Button>
							</EmptyContent>
						</Empty>
					</div>
				) : sections.length === 0 ? (
					// A non-matching SEARCH query always gets its own "no results" state, checked first —
					// otherwise an account with plenty of contacts, none matching, would fall through to the
					// add-a-contact onboarding copy. searchedSections is search-filtered but NOT
					// section-filtered, so (with no search active) empty here means genuinely nothing
					// anywhere (onboarding, with its Add contact call to action); non-empty means the account
					// has data, just none in the selected section (the narrower "nothing HERE" copy, no CTA —
					// adding a contact isn't the answer to e.g. an empty Blocked view).
					<div className="flex flex-1 overflow-y-auto">
						<Empty>
							<EmptyHeader>
								<EmptyMedia>{searching ? <SearchIcon /> : <UsersIcon />}</EmptyMedia>
								{searching ? (
									<>
										<EmptyTitle>{t("contactsSearchNoResultsTitle")}</EmptyTitle>
										<EmptyDescription>{t("contactsSearchNoResultsBody")}</EmptyDescription>
									</>
								) : searchedSections.length === 0 ? (
									<>
										<EmptyTitle>{t("contactsEmptyTitle")}</EmptyTitle>
										<EmptyDescription>{t("contactsEmptyBody")}</EmptyDescription>
									</>
								) : (
									<>
										<EmptyTitle>{t("contactsEmptySectionTitle")}</EmptyTitle>
										<EmptyDescription>{t("contactsEmptySectionBody")}</EmptyDescription>
									</>
								)}
							</EmptyHeader>
							{!searching && searchedSections.length === 0 ? (
								<EmptyContent>
									<AddContactDialog variant="default" />
								</EmptyContent>
							) : null}
						</Empty>
					</div>
				) : (
					<ContactSectionsList
						sections={sectionViews}
						bottomPadding={selected.total >= BULK_BAR_MIN_SELECTION ? BULK_BAR_PADDING : LIST_PADDING_BOTTOM}
						activeIndexFor={selection.activeIndexFor}
						onKeyDown={selection.handleKeyDown}
						renderRow={renderRow}
						revealRef={revealRef}
					/>
				)}
			</div>
			{renderActiveDialog()}
		</>
	)
}
