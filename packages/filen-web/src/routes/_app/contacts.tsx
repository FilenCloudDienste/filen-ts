import { createFileRoute } from "@tanstack/react-router"
import { ContactsList } from "@/features/contacts/components/contactsList"

// Flat page, no splat — unlike Drive there's no nested path segment. Requests/pending/contacts/
// blocked all live in ContactsList's own single unified, client-searched list.
export const Route = createFileRoute("/_app/contacts")({ component: ContactsPage })

function ContactsPage() {
	return <ContactsList />
}
