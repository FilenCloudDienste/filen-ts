import { useQuery } from "@tanstack/react-query"
import type { UserEventResult } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { noDiskPersister } from "@/queries/persist"
import { eventsQueryGet } from "@/features/settings/queries/events"
import { rawEventFields, toEventEntries, type EventEntry } from "@/features/settings/lib/eventsPagination"
import { driveNamesQueryKey, fetchDirectoryName } from "@/features/drive/queries/drive"

// Not under the events list's key: the list's invalidations must not reach it.
export function eventDetailQueryKey(uuid: string) {
	return ["settings", "eventDetail", uuid] as const
}

const EVENT_DETAIL_GC_TIME = 60 * 1000

function eventUuidOf(event: UserEventResult): string | undefined {
	return event.type === "ok" ? event.uuid : rawEventFields(event).uuid
}

function toEntry(event: UserEventResult): EventEntry | undefined {
	return toEventEntries([event])[0]
}

// The events slice's entry for `uuid`, when it holds one.
export function cachedEventEntry(uuid: string): EventEntry | undefined {
	const event = eventsQueryGet()?.find(candidate => eventUuidOf(candidate) === uuid)

	return event === undefined ? undefined : toEntry(event)
}

// A kind the SDK can't decode rejects, and reads as not found.
export async function fetchEventEntry(uuid: string): Promise<EventEntry> {
	const event = await sdkApi.getUserEvent(uuid)
	const entry = toEntry({ type: "ok", ...event })

	if (entry === undefined) {
		throw new Error(`event ${uuid} not found`)
	}

	return entry
}

// A deep-linked event the list doesn't hold: read once, by its uuid (events never change once logged).
// Its decrypted names never reach disk, and leave memory soon after the dialog closes. Held while the
// list's first page is still loading: it most likely holds the event.
export function useEventDetailQuery(uuid: string, enabled = true) {
	return useQuery({
		queryKey: eventDetailQueryKey(uuid),
		queryFn: () => fetchEventEntry(uuid),
		enabled,
		initialData: () => cachedEventEntry(uuid),
		persister: noDiskPersister,
		staleTime: Infinity,
		gcTime: EVENT_DETAIL_GC_TIME
	})
}

// The name of the directory an event's item sat in, when no cached listing holds it: the breadcrumb's
// own entry, so a directory already resolved costs nothing and one resolved here serves the breadcrumb.
export function useEventLocationNameQuery(uuid: string | undefined) {
	return useQuery({
		queryKey: driveNamesQueryKey("drive", uuid ?? ""),
		queryFn: () => fetchDirectoryName("drive", uuid === undefined ? [] : [uuid]),
		enabled: uuid !== undefined,
		staleTime: Infinity
	})
}
