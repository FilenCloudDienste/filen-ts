import { redirect } from "@tanstack/react-router"
import { isSignedIn } from "@/features/auth/lib/guard"
import { DEFAULT_START_SCREEN, getStartScreen } from "@/features/shell/lib/startScreen"
import { DEFAULT_CONTACTS_SECTION_FILTER } from "@/features/contacts/components/contactsList.logic"

// The root route (`/`) has no UI of its own — it forwards to the app when a session is present, else
// to sign-in. Split out of routes/index.tsx (same "extract the beforeLoad body so it's unit-testable
// without a router instance" shape as auth/lib/guard.ts's redirectIfAuthed) so the post-boot redirect
// switch itself — not just the persisted preference it reads — has a direct regression test.
//
// Session presence is the worker's `hasClient()` (a plain boolean check on the held Client). Any
// failure defaults to sign-in. URLs of the previous web app were already rewritten before the router started
// (lib/legacyUrl.logic.ts). This runs behind the root boot gate, so a slow/failed worker surfaces
// as the boot screen/error, never as a stuck redirect.
export async function resolveRootRedirect(): Promise<void> {
	if (!(await isSignedIn())) {
		throw redirect({ to: "/login" })
	}
	// The persisted "start screen" preference (Appearance section) — kv is already warm by this
	// point (whenBootReady's own storage() call), so this is a cheap local read, never a network
	// round trip. A switch (not a lookup table) because only the drive branch takes a splat param —
	// a shared `to`/`params` shape across all four would need to satisfy every branch's type at once.
	switch (await getStartScreen().catch(() => DEFAULT_START_SCREEN)) {
		case "notes":
			throw redirect({ to: "/notes" })
		case "chats":
			throw redirect({ to: "/chats" })
		case "contacts":
			throw redirect({ to: "/contacts/$section", params: { section: DEFAULT_CONTACTS_SECTION_FILTER } })
		case "drive":
		default:
			throw redirect({ to: "/drive/$", params: { _splat: "" } })
	}
}
