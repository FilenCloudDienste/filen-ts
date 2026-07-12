import { useState } from "react"
import { linkedFileIntoDriveItem } from "@/features/drive/lib/item"
import { usePublicFile } from "@/features/publicLinks/queries/publicLink"
import { fileAccessState } from "@/features/publicLinks/lib/password.logic"
import { PasswordGate } from "@/features/publicLinks/components/passwordGate"
import { FileHero } from "@/features/publicLinks/components/fileHero"
import { PublicLinkLoading, PublicLinkError } from "@/features/publicLinks/components/publicLinkStates"

// The /f/ route body. Resolves a LinkedFile against the anon worker surface, driving the password gate
// off the resolve outcome (a protected file throws until the password matches — there is no up-front
// flag). The typed password lives ONLY in this component's state and the query closure; a reload drops
// it and re-prompts. A file link always permits download (the LinkedFile surface carries no disable
// flag — that flag is directory-only), so the hero's download is unconditionally offered.
export function FileLinkView({ uuid, linkKey }: { uuid: string; linkKey: string }) {
	const [password, setPassword] = useState<string | undefined>(undefined)
	const [submitted, setSubmitted] = useState(false)
	const query = usePublicFile(uuid, linkKey, password)
	const access = fileAccessState({ status: query.status, error: query.error, submitted })

	if (access === "loading") {
		return <PublicLinkLoading />
	}

	if (access === "error") {
		return (
			<PublicLinkError
				onRetry={() => {
					void query.refetch()
				}}
			/>
		)
	}

	if (access === "prompt" || access === "checking" || access === "wrong") {
		return (
			<PasswordGate
				state={access}
				onSubmit={next => {
					setSubmitted(true)
					setPassword(next)
				}}
			/>
		)
	}

	if (query.data === undefined) {
		return <PublicLinkLoading />
	}

	return (
		<FileHero
			item={linkedFileIntoDriveItem(query.data)}
			downloadEnabled={true}
		/>
	)
}
