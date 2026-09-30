import { Redirect } from "expo-router"
import { useStartScreenHref } from "@/features/settings/hooks/useStartScreenHref"

export default function Index() {
	return <Redirect href={useStartScreenHref()} />
}
