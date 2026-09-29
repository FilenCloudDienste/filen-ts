import { useState } from "react"
import { linkedFileIntoDriveItem } from "@/features/drive/lib/item"
import { useLinkSaveable, usePublicFile } from "@/features/publicLinks/queries/publicLink"
import { fileAccessState } from "@/features/publicLinks/lib/password.logic"
import { secretFingerprint } from "@/features/publicLinks/lib/queryKey.logic"
import { FileHero } from "@/features/publicLinks/components/fileHero"
import { PublicLinkLoading } from "@/features/publicLinks/components/publicLinkStates"
import { LinkAccessGate } from "@/features/publicLinks/components/linkAccessGate"

// The /f/ route body. Resolves a LinkedFile against the anon worker surface, driving the password gate
// off the resolve outcome (a protected file throws until the password matches — there is no up-front
// flag). The typed password lives ONLY in this component's state and the query closure; a reload drops
// it and re-prompts. A link that disallows downloads offers neither Download nor Save to Cloud Drive, as a
// directory link without enableDownload doesn't.
export function FileLinkView({ uuid, linkKey }: { uuid: string; linkKey: string }) {
	const [password, setPassword] = useState<string | undefined>(undefined)
	const [submitted, setSubmitted] = useState(false)
	const query = usePublicFile(uuid, linkKey, password)
	const access = fileAccessState({ status: query.status, error: query.error, submitted })
	// Not asked for a link whose file may not be taken, a copy included.
	const saveable = useLinkSaveable("file", query.data?.downloadable === true ? query.data.uuid : null)

	if (access !== "ready") {
		return (
			<LinkAccessGate
				access={access}
				onRetry={() => {
					void query.refetch()
				}}
				onSubmitPassword={next => {
					// The same string again keys the same query, which would not run: check it once more, so
					// the gate goes through checking and back instead of looking dead.
					if (submitted && next === password) {
						void query.refetch()

						return
					}

					setSubmitted(true)
					setPassword(next)
				}}
			/>
		)
	}

	if (query.data === undefined) {
		return <PublicLinkLoading />
	}

	const item = linkedFileIntoDriveItem(query.data)
	const linked = query.data

	return (
		<FileHero
			item={item}
			downloadEnabled={linked.downloadable}
			linkScope={secretFingerprint(linkKey, password)}
			saveItem={saveable ? linked : undefined}
		/>
	)
}
