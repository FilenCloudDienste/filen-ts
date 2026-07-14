import auth from "@/lib/auth"
import useIncomingShareStore from "@/features/incomingShare/store/useIncomingShare.store"

// The expo-sharing share extension re-opens the app with `iofilenapp://expo-sharing`. React Native's
// built-in URL only extracts the host of http(s) URLs — `new URL("iofilenapp://expo-sharing").hostname`
// is "" for any custom scheme — so detect the share off the raw path instead of URL.hostname. Stays
// scheme-agnostic: drop an optional `scheme://`, then a leading slash, then take the authority up to the
// first `/`, `?` or `#`.
export function isIncomingSharePath(path: string): boolean {
	const authority = path
		.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
		.replace(/^\//, "")
		.split(/[/?#]/, 1)[0]

	return authority === "expo-sharing"
}

export async function redirectSystemPath({ path, initial: _ }: { path: string; initial: boolean }) {
	try {
		if (isIncomingSharePath(path)) {
			const isAuthed = await auth.isAuthed()

			if (isAuthed.isAuthed) {
				useIncomingShareStore.getState().setProcess(true)
			}
		}

		return null
	} catch {
		return null
	}
}
