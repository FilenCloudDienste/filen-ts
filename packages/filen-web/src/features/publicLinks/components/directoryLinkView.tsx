import { useState } from "react"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { usePublicDirInfo } from "@/features/publicLinks/queries/publicLink"
import { dirAccessState, linkForBrowsing } from "@/features/publicLinks/lib/password.logic"
import { PasswordGate } from "@/features/publicLinks/components/passwordGate"
import { DirectoryBrowser } from "@/features/publicLinks/components/directoryBrowser"
import { PublicLinkLoading, PublicLinkError } from "@/features/publicLinks/components/publicLinkStates"

// The /d/ route body. Resolves the directory info (root + link handle + hasPassword) up front; a
// protected link is validated by LISTING the root with the typed password set — success accepts it,
// a throw is a wrong password. The accepted password lives ONLY in this component's state and is
// threaded into every browse call via linkForBrowsing, so navigating into subfolders never re-prompts;
// a reload drops it and re-prompts by construction.
export function DirectoryLinkView({ uuid, linkKey }: { uuid: string; linkKey: string }) {
	const info = usePublicDirInfo(uuid, linkKey)
	const [accepted, setAccepted] = useState<string | undefined>(undefined)
	const [verifying, setVerifying] = useState(false)
	const [failed, setFailed] = useState(false)

	const access = dirAccessState({
		infoStatus: info.status,
		hasPassword: info.data?.hasPassword ?? false,
		accepted: accepted !== undefined,
		verifying,
		failed
	})

	function verify(candidate: string): void {
		const data = info.data

		if (data === undefined) {
			return
		}

		setVerifying(true)
		setFailed(false)

		void runOp(sdkApi.listLinkedDirAnon(data.root, linkForBrowsing(data, candidate)))
			.then(() => {
				setAccepted(candidate)
			})
			.catch(() => {
				setFailed(true)
			})
			.finally(() => {
				setVerifying(false)
			})
	}

	if (access === "loading") {
		return <PublicLinkLoading />
	}

	if (access === "error") {
		return (
			<PublicLinkError
				onRetry={() => {
					void info.refetch()
				}}
			/>
		)
	}

	if (access === "prompt" || access === "checking" || access === "wrong") {
		return (
			<PasswordGate
				state={access}
				onSubmit={verify}
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
