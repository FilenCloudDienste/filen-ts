import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"

// Two independent caches, mirroring filen-mobile's own split (useContacts.query.ts /
// useContactRequests.query.ts): contacts+blocked change together (block/unblock moves an entry
// between them), while incoming/outgoing requests move on their own timeline. An action that
// touches both (accepting a request promotes it into the contact list) patches/invalidates both
// keys at its own call site — this module owns neither cross-key coupling. Both keys are the bare
// domain tuple: there is exactly one contacts cache and one requests cache per session, same
// rationale as ACCOUNT_QUERY_KEY in queries/account.ts.
export const CONTACTS_QUERY_KEY = ["contacts"] as const

export interface ContactsQueryData {
	contacts: Contact[]
	blocked: BlockedContact[]
}

// Plain, testable query function — same rationale as fetchAccount/fetchDirectoryListing: the hook
// wrapper below is a one-line pass-through no node-environment test can render (no DOM — see
// vitest.config.ts), so this is exported and unit-tested against a mocked sdkApi instead. Parallel,
// not sequential: the established contact list and the blocked list are unrelated reads
// server-side, so there is no reason to pay two round trips in series.
export async function fetchContacts(): Promise<ContactsQueryData> {
	const [contacts, blocked] = await Promise.all([sdkApi.getContacts(), sdkApi.getBlockedContacts()])
	return { contacts, blocked }
}

export function useContactsQuery(): UseQueryResult<ContactsQueryData> {
	return useQuery({
		queryKey: CONTACTS_QUERY_KEY,
		queryFn: fetchContacts
	})
}

// Confirm-then-patch (queries/client.ts's zero-useMutation convention). A cache miss (nobody has
// mounted the contacts page yet) defaults to empty arrays so the patch still lands for whenever it
// first mounts, same rule as driveListingQueryUpdate.
export function contactsQueryUpdate(updater: (prev: ContactsQueryData) => ContactsQueryData): void {
	queryClient.setQueryData<ContactsQueryData>(CONTACTS_QUERY_KEY, prev => updater(prev ?? { contacts: [], blocked: [] }))
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

export async function fetchContactRequests(): Promise<ContactRequestsQueryData> {
	const [incoming, outgoing] = await Promise.all([sdkApi.listIncomingContactRequests(), sdkApi.listOutgoingContactRequests()])
	return { incoming, outgoing }
}

export function useContactRequestsQuery(): UseQueryResult<ContactRequestsQueryData> {
	return useQuery({
		queryKey: CONTACT_REQUESTS_QUERY_KEY,
		queryFn: fetchContactRequests
	})
}

export function contactRequestsQueryUpdate(updater: (prev: ContactRequestsQueryData) => ContactRequestsQueryData): void {
	queryClient.setQueryData<ContactRequestsQueryData>(CONTACT_REQUESTS_QUERY_KEY, prev => updater(prev ?? { incoming: [], outgoing: [] }))
}
