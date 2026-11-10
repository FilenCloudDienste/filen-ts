import { QueryObserver, type QueryClient } from "@tanstack/react-query"
import type { UserInfo } from "@filen/sdk-rs"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { bindKeymapAccount } from "@/lib/keymap/registry"

function selectUserId(info: UserInfo): string {
	return String(info.id)
}

// The keymap follows the signed-in account: its record is keyed by user id (lib/keymap/storage.ts). Reads the account
// the app already holds (restored at boot, fetched at sign-in) without ever fetching it: the observer is disabled and
// selects only the id, so it hears nothing of the per-upload patches.
export function followKeymapAccount(client: QueryClient): () => void {
	const observer = new QueryObserver<UserInfo, Error, string>(client, {
		queryKey: ACCOUNT_QUERY_KEY,
		enabled: false,
		select: selectUserId
	})
	const bind = (userId: string | undefined): void => {
		if (userId !== undefined) {
			void bindKeymapAccount(userId)
		}
	}

	bind(observer.getCurrentResult().data)

	return observer.subscribe(result => {
		bind(result.data)
	})
}
