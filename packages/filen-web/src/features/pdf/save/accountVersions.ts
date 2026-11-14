import { accountQueryGet } from "@/queries/account"
import { log } from "@/lib/log"

// Whether the account keeps earlier versions, from the cached account; not kept while it is unknown (a save then never
// relies on the old version staying readable, and never waits on a read of the account).
export function accountKeepsVersions(): boolean {
	const known = accountQueryGet()?.versioningEnabled

	if (known === undefined) log.warn("pdf", "the account's versioning is not known: earlier versions taken as not kept")

	return known === true
}
