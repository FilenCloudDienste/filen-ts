import { useState } from "react"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { runOp } from "@/lib/actions/outcome"
import { queryClient } from "@/queries/client"
import { usePublicDirInfo, publicDirListingQueryKey } from "@/features/publicLinks/queries/publicLink"
import { dirAccessState, linkForBrowsing } from "@/features/publicLinks/lib/password.logic"
import { rootCrumb } from "@/features/publicLinks/lib/browse.logic"
import { DirectoryBrowser } from "@/features/publicLinks/components/directoryBrowser"
import { PublicLinkLoading } from "@/features/publicLinks/components/publicLinkStates"
import { LinkAccessGate } from "@/features/publicLinks/components/linkAccessGate"
import { useReportPassword } from "@/features/publicLinks/lib/reportSubject"

// The /d/ route body. Resolves the directory info (root + link handle + hasPassword) up front; a
// protected link is validated by LISTING the root with the typed password set — success accepts it,
// a rejection is classified by dirAccessState (wrong password vs retryable network failure). The
// accepted password lives ONLY in this component's state and is threaded into every browse call via
// linkForBrowsing, so navigating into subfolders never re-prompts; a reload drops it and re-prompts
// by construction. An abuse report reads it from memory too.
export function DirectoryLinkView({ uuid, linkKey }: { uuid: string; linkKey: string }) {
	const info = usePublicDirInfo(uuid, linkKey)
	const [accepted, setAccepted] = useState<string | undefined>(undefined)
	const [verifying, setVerifying] = useState(false)
	const [verifyError, setVerifyError] = useState<ErrorDTO | undefined>(undefined)

	// An abuse report carries the accepted password, so staff can open the link.
	useReportPassword(accepted)

	const access = dirAccessState({
		infoStatus: info.status,
		infoError: info.error,
		hasPassword: info.data?.hasPassword ?? false,
		accepted: accepted !== undefined,
		verifying,
		verifyError
	})

	function verify(candidate: string): void {
		const data = info.data

		if (data === undefined) {
			return
		}

		setVerifying(true)
		setVerifyError(undefined)

		const root = rootCrumb(data)
		const link = linkForBrowsing(data, candidate)

		void runOp(sdkApi.listLinkedDirAnon(root.dir, link))
			.then(listing => {
				// The browser's first level is this same root under this same link, so it opens on this read.
				queryClient.setQueryData(publicDirListingQueryKey(root.uuid, link), listing)
				setAccepted(candidate)
			})
			.catch((e: unknown) => {
				setVerifyError(asErrorDTO(e))
			})
			.finally(() => {
				setVerifying(false)
			})
	}

	if (access !== "ready") {
		return (
			<LinkAccessGate
				access={access}
				onRetry={() => {
					// An info failure refetches the info. A failed verify returns to the prompt rather than
					// re-running with the last candidate, so the typed password is not kept in state.
					if (info.status === "error") {
						void info.refetch()

						return
					}

					setVerifyError(undefined)
				}}
				onSubmitPassword={verify}
			/>
		)
	}

	if (info.data === undefined) {
		return <PublicLinkLoading />
	}

	return (
		<DirectoryBrowser
			info={info.data}
			link={linkForBrowsing(info.data, accepted)}
		/>
	)
}
