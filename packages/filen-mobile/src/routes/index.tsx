import { Redirect } from "expo-router"
import { useIsAuthed, useStringifiedClient } from "@/lib/auth"

export default function Index() {
	const isAuthed = useIsAuthed()
	const stringifiedClient = useStringifiedClient()

	if (!isAuthed) {
		return <Redirect href="/auth/login" />
	}

	return (
		<Redirect
			href={{
				pathname: "/tabs/drive/[uuid]",
				params: {
					uuid: stringifiedClient?.rootUuid ?? "root"
				}
			}}
		/>
	)
}
