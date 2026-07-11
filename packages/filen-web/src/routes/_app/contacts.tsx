import { createFileRoute } from "@tanstack/react-router"
import { ContactsList } from "@/features/contacts/components/contactsList"
import {
	DEFAULT_CONTACTS_SECTION_FILTER,
	isContactsSectionFilter,
	type ContactsSectionFilter
} from "@/features/contacts/components/contactsList.logic"

// Flat page, no splat — unlike Drive there's no nested path segment. Requests/pending/contacts/
// blocked all live in ContactsList's own single sectioned list, switched by this route's own
// `section` search param (owned by ContactsSidebar — see features/contacts/components/
// contactsSidebar.tsx) rather than a nested path: the page itself has no path params to extend, so a
// search param stays the less invasive of the two ways to make the active section deep-linkable.
interface ContactsSearch {
	section: ContactsSectionFilter
}

function validateSearch(search: Record<string, unknown>): ContactsSearch {
	const raw = search["section"]

	return { section: typeof raw === "string" && isContactsSectionFilter(raw) ? raw : DEFAULT_CONTACTS_SECTION_FILTER }
}

// No stripSearchParams here (deliberately, despite the "all" filter being the default): a Link's own
// active-highlight is computed by resolving ITS OWN target location through the same search
// middleware pipeline used for real navigations, so a middleware that elides "section=all" back down
// to an empty object would make the sidebar's "All" entry match against ANY current section (an empty
// object partially matches everything) — always showing active, never actually distinguishing. Every
// section, "all" included, always serializes explicitly instead.
export const Route = createFileRoute("/_app/contacts")({
	validateSearch,
	component: ContactsPage
})

function ContactsPage() {
	const { section } = Route.useSearch()

	return <ContactsList section={section} />
}
