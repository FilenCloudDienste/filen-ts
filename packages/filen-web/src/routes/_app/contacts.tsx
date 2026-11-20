import { createFileRoute, Outlet } from "@tanstack/react-router"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Contacts layout parent: contacts.index (/contacts) forwards to the default section, contacts.$section
// (/contacts/$section) renders it. Requests/pending/contacts/blocked all live in ContactsList's own single
// sectioned list; the section in the path keeps every sidebar entry's active-link match exact.
export const Route = createFileRoute("/_app/contacts")({
	head: routeHead({ title: () => [i18n.t("common:moduleContacts")] }),
	component: ContactsLayout
})

function ContactsLayout() {
	return <Outlet />
}
