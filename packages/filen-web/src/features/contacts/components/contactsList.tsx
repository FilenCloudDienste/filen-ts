import { useState, type MouseEvent, type ReactNode } from "react"
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
import { useAction } from "@/lib/keymap/useAction"
import { isAnyDialogOpen } from "@/lib/keymap/dialogGuard"
import {
	buildContactSections,
	filterContactSections,
	CONTACTS_SECTION_HEADER_KEY,
	type ContactSection,
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
import { toastContactsBulkOutcome } from "@/features/contacts/lib/bulkToast"
import { resolveSelectedContacts, type ContactSectionKey } from "@/features/contacts/lib/selection"
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
import { cn } from "@filen/shared"
import { SURFACE_RING } from "@/components/ui/surface"

// Every section's rows sit in one of these: a rounded, ringed panel (ui/card.tsx's ring language) with
// hairline dividers between rows.
const SECTION_PANEL_CLASS = "flex flex-col divide-y overflow-hidden rounded-2xl ring-1"

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
// host). `section` is owned by the route (its own `section` search param, see
// routes/_app/contacts.tsx) — the sidebar and this page are siblings under appShell, not
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
	const selection = useContactsListSelection({ resetKey: section })
	const { activeDialog, setActiveDialog, dialogPending, closeActiveDialog, runDialogPending, runDialogOutcome } =
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
	// Guarded through the shared DOM-level dialog signal rather than this host's own isDialogOpen:
	// AddContactDialog owns its own open state outside the host, and Escape must close whichever dialog
	// is up without also clearing the selection behind it.
	useAction(
		"contacts.clearSelection",
		() => {
			if (isAnyDialogOpen()) {
				return
			}

			selection.clearSelection()
		},
		undefined,
		[selection]
	)

	// No confirm (mirrors mobile) — silent success, LABEL-FIRST toast on failure, matching every
	// other singular contact action's convention (see runSingleDialogAction below).
	async function handleAccept(request: ContactRequestIn): Promise<void> {
		if (accepting.claim([request.uuid]).length === 0) {
			return
		}

		const outcome = await acceptRequest(request.uuid)

		accepting.release([request.uuid])

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))

			return
		}

		selection.pruneSelection("requests", [request.uuid])
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

	async function handleBulkAccept(items: ContactRequestIn[]): Promise<void> {
		const claimed = new Set(accepting.claim(items.map(request => request.uuid)))

		if (claimed.size === 0) {
			return
		}

		const outcome = await runBulkOutcomes(
			items.filter(request => claimed.has(request.uuid)),
			request => acceptRequest(request.uuid)
		)

		accepting.release([...claimed])
		toastContactsBulkOutcome(outcome)
		selection.pruneSelection(
			"requests",
			outcome.succeeded.map(request => request.uuid)
		)
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

	// Shared tail for a bulk confirm: run every item independently via runBulkOutcomes, always close
	// (the toast conveys any partial failure), and prune succeeded uuids from the selection — mirrors
	// directoryListing.tsx's runBulkDialogAction.
	async function runBulkDialogAction<T extends { uuid: string }>(
		section: ContactSectionKey,
		items: T[],
		op: (item: T) => Promise<VoidActionOutcome>
	): Promise<void> {
		const outcome = await runDialogPending(() => runBulkOutcomes(items, op))
		closeActiveDialog()
		toastContactsBulkOutcome(outcome)
		selection.pruneSelection(
			section,
			outcome.succeeded.map(item => item.uuid)
		)
	}

	// Generic over the item type so each switch case below keeps its own narrowed `items`.
	function renderConfirm<T extends { uuid: string }>(spec: {
		title: string
		body: string
		confirmLabel: string
		destructive?: boolean
		section: ContactSectionKey
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
				cancelLabel={t("common:cancel")}
				destructive={spec.destructive ?? false}
				onOpenChange={open => {
					if (!open) {
						closeActiveDialog()
					}
				}}
				onConfirm={() => {
					if (spec.bulk) {
						void runBulkDialogAction(spec.section, spec.items, spec.op)
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
					body: t("contactsDenyConfirmBody", { count }),
					confirmLabel: t("contactsActionDeny"),
					section: "requests",
					items: activeDialog.items,
					bulk: activeDialog.bulk,
					op: request => denyRequest(request.uuid)
				})
			case "cancel":
				return renderConfirm({
					title: t("contactsCancelConfirmTitle"),
					body: t("contactsCancelConfirmBody", { count }),
					confirmLabel: t("contactsActionCancelRequest"),
					section: "pending",
					items: activeDialog.items,
					bulk: activeDialog.bulk,
					op: request => cancelRequest(request.uuid)
				})
			case "remove":
				return renderConfirm({
					title: t("contactsRemoveConfirmTitle"),
					body: t("contactsRemoveConfirmBody", { count }),
					confirmLabel: t("contactsActionRemove"),
					destructive: true,
					section: "contacts",
					items: activeDialog.items,
					bulk: activeDialog.bulk,
					op: contact => removeContact(contact.uuid)
				})
			case "block":
				return renderConfirm({
					title: t("contactsBlockConfirmTitle"),
					body: t("contactsBlockConfirmBody", { count }),
					confirmLabel: t("contactsActionBlock"),
					destructive: true,
					section: "contacts",
					items: activeDialog.items,
					bulk: activeDialog.bulk,
					op: contact => blockContact(contact)
				})
			case "unblock":
				return renderConfirm({
					title: t("contactsUnblockConfirmTitle"),
					body: t("contactsUnblockConfirmBody", { count }),
					confirmLabel: t("contactsActionUnblock"),
					section: "blocked",
					items: activeDialog.items,
					bulk: activeDialog.bulk,
					op: contact => unblockContact(contact.uuid)
				})
		}
	}

	// One row per section item, dispatched on the section's own key — the key already discriminates
	// `items`' concrete type (see contactsList.logic.ts's ContactSection), so no per-item type tag is
	// needed the way mobile's flat single-list rendering requires one. Every row is permanently a
	// listbox option AND permanently shows its own actions; only the cursor row (and its controls) is
	// tabbable, so the section's Tab cost stays 1 regardless of how many contacts an account has.
	function renderSectionItems(contactSection: ContactSection, uuids: string[]): ReactNode {
		const key = contactSection.key
		const activeIndex = selection.activeIndexFor(key, uuids)

		function rowProps(uuid: string, index: number) {
			return {
				selected: selection.selection[key].has(uuid),
				active: index === activeIndex,
				rowRef: (element: HTMLDivElement | null) => {
					selection.registerRowRef(key, uuid, element)
				},
				onSelect: (event: MouseEvent<HTMLDivElement>) => {
					selection.handlePointerSelect(key, uuids, index, event)
				}
			}
		}

		switch (contactSection.key) {
			case "requests":
				return contactSection.items.map((request, index) => (
					<ContactRow
						key={request.uuid}
						contact={request}
						{...rowProps(request.uuid, index)}
					>
						<IncomingRequestActions
							request={request}
							disabled={!isOnline || accepting.inFlight.has(request.uuid)}
							title={offlineTitle}
							tabIndex={index === activeIndex ? 0 : -1}
							onAccept={item => {
								void handleAccept(item)
							}}
							onDeny={item => {
								setActiveDialog({ kind: "deny", bulk: false, items: [item] })
							}}
						/>
					</ContactRow>
				))
			case "pending":
				return contactSection.items.map((request, index) => (
					<ContactRow
						key={request.uuid}
						contact={request}
						{...rowProps(request.uuid, index)}
					>
						<OutgoingRequestActions
							request={request}
							disabled={!isOnline}
							title={offlineTitle}
							tabIndex={index === activeIndex ? 0 : -1}
							onCancel={item => {
								setActiveDialog({ kind: "cancel", bulk: false, items: [item] })
							}}
						/>
					</ContactRow>
				))
			case "contacts":
				return contactSection.items.map((contact, index) => (
					<ContactRow
						key={contact.uuid}
						contact={contact}
						{...rowProps(contact.uuid, index)}
					>
						<ContactActions
							contact={contact}
							disabled={!isOnline}
							title={offlineTitle}
							tabIndex={index === activeIndex ? 0 : -1}
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
				))
			case "blocked":
				return contactSection.items.map((blocked, index) => (
					<ContactRow
						key={blocked.uuid}
						contact={blocked}
						{...rowProps(blocked.uuid, index)}
					>
						<BlockedActions
							contact={blocked}
							disabled={!isOnline}
							title={offlineTitle}
							tabIndex={index === activeIndex ? 0 : -1}
							onUnblock={item => {
								setActiveDialog({ kind: "unblock", bulk: false, items: [item] })
							}}
						/>
					</ContactRow>
				))
		}
	}

	// "all" stacks every section, so each one carries its own heading: incoming requests as a tinted
	// callout (they wait on the reader), the rest as a quiet labelled group. A single-section view is
	// already named by the page's <h1>, so it gets the bare panel.
	function renderSection(contactSection: ContactSection): ReactNode {
		// One array identity per render, shared by the container's key handler and its rows.
		const uuids = contactSection.items.map(item => item.uuid)
		const label = t(CONTACTS_SECTION_HEADER_KEY[contactSection.key])
		const callout = section === "all" && contactSection.key === "requests"
		const listbox = (
			<div
				role="listbox"
				aria-multiselectable="true"
				aria-label={label}
				// One roving Tab stop per section: the cursor row (and only its controls) is tabbable,
				// Arrow/Home/End move it, Space/Enter toggle it. Same contract as drive's listbox —
				// contacts renders every row of every section at once, so a Tab stop per row would scale
				// with the account.
				onKeyDown={event => {
					selection.handleKeyDown(contactSection.key, uuids, event)
				}}
				className={callout ? "flex flex-col divide-y divide-primary/10" : cn(SECTION_PANEL_CLASS, "divide-border", SURFACE_RING)}
			>
				{renderSectionItems(contactSection, uuids)}
			</div>
		)

		if (callout) {
			return (
				<section
					key={contactSection.key}
					className={cn(SECTION_PANEL_CLASS, "bg-primary/3 ring-primary/15 dark:bg-primary/5")}
				>
					<h2 className="px-3 pt-3 pb-2 text-sm font-medium">
						{t("contactsRequestsCalloutTitle", { count: contactSection.items.length })}
					</h2>
					{listbox}
				</section>
			)
		}

		return (
			<section key={contactSection.key}>
				{section === "all" ? (
					<h2 className="px-1 pb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
						{t("contactsSectionHeading", { section: label, count: contactSection.items.length })}
					</h2>
				) : null}
				{listbox}
			</section>
		)
	}

	const searching = search.trim().length > 0

	return (
		<>
			{/* Header, search and list share one centred column; the scroller itself stays full-width so its
			scrollbar sits at the pane's edge rather than the column's. */}
			<header className="flex h-14 shrink-0 items-center px-4">
				<div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4">
					<h1 className="truncate text-sm font-medium">
						{section === "all" ? t("common:moduleContacts") : t(CONTACTS_SECTION_HEADER_KEY[section])}
					</h1>
					<AddContactDialog />
				</div>
			</header>
			<div className="shrink-0 px-4 pb-4">
				<div className="relative mx-auto w-full max-w-3xl">
					<SearchIcon
						aria-hidden="true"
						className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
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
							onAccept={items => {
								void handleBulkAccept(items)
							}}
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
					<div className="flex-1 overflow-y-auto px-4">
						<div
							className={cn(
								"mx-auto flex w-full max-w-3xl flex-col gap-6 pt-1",
								// Room for the floating bulk bar, so it never covers the last row.
								selected.total >= BULK_BAR_MIN_SELECTION ? "pb-16" : "pb-6"
							)}
						>
							{sections.map(renderSection)}
						</div>
					</div>
				)}
			</div>
			{renderActiveDialog()}
		</>
	)
}
