import { useQuery, type QueryKey, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { currentSocketEpoch, socketLiveSince } from "@/lib/sdk/socketSession"
import { queryClient } from "@/queries/client"
import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"

// Two independent caches, mirroring filen-mobile's own split (useContacts.query.ts /
// useContactRequests.query.ts): contacts+blocked change together (block/unblock moves an entry
// between them), while incoming/outgoing requests move on their own timeline. An action that
// touches both (accepting a request promotes it into the contact list) patches both keys at its own
// call site — this module owns neither cross-key coupling. Both keys are the bare domain tuple:
// there is exactly one contacts cache and one requests cache per session, same rationale as
// ACCOUNT_QUERY_KEY in queries/account.ts.
export const CONTACTS_QUERY_KEY = ["contacts"] as const

export interface ContactsQueryData {
	contacts: Contact[]
	blocked: BlockedContact[]
}

// No socket event reaches contacts, blocked contacts or outgoing requests, and incoming requests only
// gain rows by event (a sender's cancel or an answer from another device never arrives), so a change
// made elsewhere shows on the next focus or mount after this window. This tab's own writes patch both
// caches, so they never wait on it.
export const CONTACTS_STALE_TIME = 5 * 60 * 1000

// A persisted row restores with its original read time, and nothing replays what changed while the app
// was closed, so until a read of this session counts, each cache refetches like any staleTime-0 query.
let contactsReadThisSession = false

// Plain, testable query function — same rationale as fetchAccount/fetchDirectoryListing: the hook
// wrapper below is a one-line pass-through no node-environment test can render (no DOM — see
// vitest.config.ts), so this is exported and unit-tested against a mocked sdkApi instead. Parallel,
// not sequential: the established contact list and the blocked list are unrelated reads
// server-side, so there is no reason to pay two round trips in series.
export async function fetchContacts(): Promise<ContactsQueryData> {
	const [contacts, blocked] = await Promise.all([sdkApi.getContacts(), sdkApi.getBlockedContacts()])

	contactsReadThisSession = true

	return { contacts, blocked }
}

// `enabled` lets a caller skip the fetch entirely, same convention as queries/drive.ts's
// useItemInfoQuery — useBlockedUsers.ts uses this to fetch contacts/blocked only for the sharedIn
// drive listing (the one variant that filters by the blocked set), instead of paying a getContacts +
// getBlockedContacts worker round trip on the mounts and refocuses of every other variant. Defaults
// to true so contactsList.tsx's own bare call is unaffected.
export function useContactsQuery(options?: { enabled?: boolean }): UseQueryResult<ContactsQueryData> {
	return useQuery({
		queryKey: CONTACTS_QUERY_KEY,
		queryFn: fetchContacts,
		enabled: options?.enabled ?? true,
		staleTime: () => (contactsReadThisSession ? CONTACTS_STALE_TIME : 0),
		refetchOnReconnect: "always"
	})
}

// Cancel-before-patch WITH the initial-fetch carve-out (notesQueryUpdate's rule): a refetch
// snapshotted on the server BEFORE this write would land after the patch and silently overwrite it —
// abort anything in flight first, but only when cached data already exists. Cancelling
// a query's INITIAL fetch would strand it on its loading state with nothing to show until the next
// mount/focus trigger, and the overwrite hazard only applies to data a patch can lose.
//
// setQueryData marks the cache fresh, dropping a pending invalidation and the read cancelled here; left
// unrestored, the change behind them would wait out the stale time.
function patchQuery<T>(queryKey: QueryKey, updater: (prev: T | undefined) => T): void {
	const query = queryClient.getQueryCache().find({ queryKey, exact: true })
	const refreshPending = query !== undefined && (query.state.isInvalidated || query.state.fetchStatus !== "idle")

	if (queryClient.getQueryData(queryKey) !== undefined) {
		void queryClient.cancelQueries({ queryKey })
	}

	queryClient.setQueryData<T>(queryKey, updater)

	if (refreshPending) {
		void queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "none" })
	}
}

// Confirm-then-patch (queries/client.ts's zero-useMutation convention). A cache miss (nobody has
// mounted the contacts page yet) defaults to empty arrays so the patch still lands for whenever it
// first mounts.
export function contactsQueryUpdate(updater: (prev: ContactsQueryData) => ContactsQueryData): void {
	patchQuery<ContactsQueryData>(CONTACTS_QUERY_KEY, prev => updater(prev ?? { contacts: [], blocked: [] }))
}

// Synchronous cache read for a caller that needs the current contact/blocked list without
// subscribing via the hook — mirrors mobile's own contactsQueryGet, whose one real consumer (a
// chat/note participant row's block-toggle action, resolving a userId to its BlockedContact uuid)
// lands in a later task here too.
export function contactsQueryGet(): ContactsQueryData | undefined {
	return queryClient.getQueryData<ContactsQueryData>(CONTACTS_QUERY_KEY)
}

export const CONTACT_REQUESTS_QUERY_KEY = ["contactRequests"] as const

export interface ContactRequestsQueryData {
	incoming: ContactRequestIn[]
	outgoing: ContactRequestOut[]
}

// Socket epoch of the latest requests read that ran entirely under a live socket. The window holds only
// while that socket session lasts: a request received during a drop never arrives as an event.
let requestsReadEpoch: number | null = null

export async function fetchContactRequests(): Promise<ContactRequestsQueryData> {
	const epoch = currentSocketEpoch()
	const [incoming, outgoing] = await Promise.all([sdkApi.listIncomingContactRequests(), sdkApi.listOutgoingContactRequests()])

	requestsReadEpoch = socketLiveSince(epoch) ? epoch : null

	return { incoming, outgoing }
}

export function useContactRequestsQuery(): UseQueryResult<ContactRequestsQueryData> {
	return useQuery({
		queryKey: CONTACT_REQUESTS_QUERY_KEY,
		queryFn: fetchContactRequests,
		staleTime: () => (socketLiveSince(requestsReadEpoch) ? CONTACTS_STALE_TIME : 0),
		refetchOnReconnect: "always"
	})
}

export function contactRequestsQueryUpdate(updater: (prev: ContactRequestsQueryData) => ContactRequestsQueryData): void {
	patchQuery<ContactRequestsQueryData>(CONTACT_REQUESTS_QUERY_KEY, prev => updater(prev ?? { incoming: [], outgoing: [] }))
}

// Reads back one half of a cache after a write whose op returns too little to patch it. One read runs
// at a time, and a call made while one is in flight gets a read that starts after it: the earlier one
// may predate the caller's write, and reads settling out of order would drop it. A patch to that half
// landing mid-read may postdate the answer, so the half is read once more. A failed read marks the
// cache stale, so the next mount or focus reads it whole, and rejects.
function createReadBack<T>(queryKey: QueryKey, cached: () => T | undefined, read: () => Promise<T>, apply: (value: T) => void) {
	let inFlight: Promise<void> | null = null
	let queued: Promise<void> | null = null

	async function run(): Promise<void> {
		try {
			const before = cached()
			let value = await read()

			if (cached() !== before) {
				value = await read()
			}

			apply(value)
		} catch (e) {
			void queryClient.invalidateQueries({ queryKey })

			throw e
		}
	}

	function start(): Promise<void> {
		inFlight = run().finally(() => {
			inFlight = null
		})

		return inFlight
	}

	return (): Promise<void> => {
		if (inFlight === null) {
			return start()
		}

		queued ??= inFlight
			.catch(() => undefined)
			.then(() => {
				queued = null

				return start()
			})

		return queued
	}
}

export const rereadContactList = createReadBack(
	CONTACTS_QUERY_KEY,
	() => contactsQueryGet()?.contacts,
	() => sdkApi.getContacts(),
	contacts => {
		contactsQueryUpdate(prev => ({ ...prev, contacts }))
	}
)

export const rereadOutgoingRequests = createReadBack(
	CONTACT_REQUESTS_QUERY_KEY,
	() => queryClient.getQueryData<ContactRequestsQueryData>(CONTACT_REQUESTS_QUERY_KEY)?.outgoing,
	() => sdkApi.listOutgoingContactRequests(),
	outgoing => {
		contactRequestsQueryUpdate(prev => ({ ...prev, outgoing }))
	}
)
