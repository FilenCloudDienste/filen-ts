import auth from "@/lib/auth"
import useIncomingShareStore from "@/stores/useIncomingShare.store"

export async function redirectSystemPath({ path, initial: _ }: { path: string; initial: boolean }) {
	try {
		if (new URL(path).hostname === "expo-sharing") {
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
