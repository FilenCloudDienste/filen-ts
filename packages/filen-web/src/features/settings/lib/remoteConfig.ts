import { type, type ArkErrors } from "arktype"
import { useQuery, type QueryClient, type QueryFunctionContext, type UseQueryResult } from "@tanstack/react-query"
import { kvPreference } from "@/lib/storage/preference"
import { noDiskPersister } from "@/queries/persist"
import { log } from "@/lib/log"

// The service's remote config (cfg.json on the CDN): maintenance flag, announcements and plan pricing. One query
// serves every consumer; mount it only in the signed-in app.

// The test file carries sale and lifetime pricing, so dev builds can show those states. Its plan ids are not the
// production ones.
export const REMOTE_CONFIG_URL = `https://cdn.filen.io/${import.meta.env.DEV ? "cfg.test.json" : "cfg.json"}`

const FETCH_TIMEOUT_MS = 10_000
const REFETCH_INTERVAL_MS = 10 * 60 * 1000
const STALE_TIME_MS = 5 * 60 * 1000
// The backend re-reads the file about every 30-60 s; while maintenance is on, notice its end that fast.
const MAINTENANCE_REFETCH_INTERVAL_MS = 30_000

export const REMOTE_CONFIG_QUERY_KEY = ["remoteConfig", "cfg"] as const

// Undeclared keys are stripped so new server fields cost nothing in memory.
const announcementSchema = type({
	"+": "delete",
	uuid: "string > 0",
	title: "string",
	message: "string",
	active: "boolean",
	timestamp: "number",
	platforms: "string[]"
})

const planSchema = type({
	"+": "delete",
	termType: "number.integer",
	id: "number.integer",
	name: "string",
	cost: "number",
	sale: "number",
	storage: "number >= 0",
	popular: "boolean",
	term: "'monthly' | 'annually' | 'lifetime'"
})

const pricingHeaderSchema = type({
	"+": "delete",
	lifetimeEnabled: "boolean",
	saleEnabled: "boolean",
	plans: "unknown[]"
})

export type Announcement = typeof announcementSchema.infer
export type PricingPlan = typeof planSchema.infer
export type PlanTerm = PricingPlan["term"]

export interface Pricing {
	lifetimeEnabled: boolean
	saleEnabled: boolean
	plans: PricingPlan[]
}

export interface RemoteConfig {
	maintenance: boolean
	// Parsed for completeness; nothing acts on it yet.
	readOnly: boolean
	announcements: Announcement[]
	// null when the section is malformed: plans are hidden, the rest of the config still applies.
	pricing: Pricing | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Each item on its own: one malformed entry is dropped, never the list.
function parseItems<T>(value: unknown, schema: (input: unknown) => T | ArkErrors): T[] {
	if (!Array.isArray(value)) {
		return []
	}

	const items: T[] = []

	for (const item of value) {
		const parsed = schema(item)

		if (!(parsed instanceof type.errors)) {
			items.push(parsed)
		}
	}

	return items
}

function parsePricing(value: unknown): Pricing | null {
	const header = pricingHeaderSchema(value)

	if (header instanceof type.errors) {
		return null
	}

	return {
		lifetimeEnabled: header.lifetimeEnabled,
		saleEnabled: header.saleEnabled,
		plans: parseItems(header.plans, planSchema)
	}
}

// Section by section, so a bad pricing block or announcement never discards the maintenance flag. null only when the
// body is not an object at all.
export function parseRemoteConfig(raw: unknown): RemoteConfig | null {
	if (!isRecord(raw)) {
		return null
	}

	return {
		maintenance: raw["maintenance"] === true,
		readOnly: raw["readOnly"] === true,
		announcements: parseItems(raw["announcements"], announcementSchema),
		pricing: parsePricing(raw["pricing"])
	}
}

// The file has no Cache-Control, so a plain fetch could be answered from heuristic HTTP cache for days: no-cache
// revalidates with the ETag (a bodyless 304 when unchanged). Every failure is null.
export async function fetchRemoteConfig(signal: AbortSignal): Promise<RemoteConfig | null> {
	try {
		const response = await fetch(REMOTE_CONFIG_URL, {
			credentials: "omit",
			cache: "no-cache",
			signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
		})

		if (!response.ok) {
			log.warn("remoteConfig", `fetch failed: HTTP ${String(response.status)}`)

			return null
		}

		const config = parseRemoteConfig(await response.json())

		if (config === null) {
			log.warn("remoteConfig", "body is not a config object")
		}

		return config
	} catch (e) {
		log.warn("remoteConfig", "fetch failed", e)

		return null
	}
}

// Never rejects (a failure would log through the global onError every interval while the CDN is unreachable): a
// failed read keeps what this session last fetched, or null.
export async function queryRemoteConfig(context: QueryFunctionContext<typeof REMOTE_CONFIG_QUERY_KEY>): Promise<RemoteConfig | null> {
	const fetched = await fetchRemoteConfig(context.signal)

	return fetched ?? context.client.getQueryData<RemoteConfig | null>(REMOTE_CONFIG_QUERY_KEY) ?? null
}

interface RemoteConfigQueryState {
	state: { data: RemoteConfig | null | undefined }
}

export function remoteConfigRefetchInterval(query: RemoteConfigQueryState): number {
	return query.state.data?.maintenance === true ? MAINTENANCE_REFETCH_INTERVAL_MS : REFETCH_INTERVAL_MS
}

export function remoteConfigStaleTime(query: RemoteConfigQueryState): number {
	return query.state.data?.maintenance === true ? 0 : STALE_TIME_MS
}

// Never on disk: a restored maintenance flag would show before (or, offline, instead of) a fresh read, and stale
// pricing could offer retired plans. One conditional request per session is cheaper than a kv row anyway.
// The interval only runs while the document is visible (refetchIntervalInBackground stays false), and returning to
// the tab refetches once stale through refetchOnWindowFocus.
export function remoteConfigQueryOptions() {
	return {
		queryKey: REMOTE_CONFIG_QUERY_KEY,
		queryFn: queryRemoteConfig,
		persister: noDiskPersister<RemoteConfig | null, typeof REMOTE_CONFIG_QUERY_KEY>,
		refetchInterval: remoteConfigRefetchInterval,
		staleTime: remoteConfigStaleTime
	}
}

// Consumers read slices through `select`, so a pricing change never re-renders the shell's strip.
export function useRemoteConfigQuery<T>(select: (config: RemoteConfig | null) => T): UseQueryResult<T> {
	return useQuery({ ...remoteConfigQueryOptions(), select })
}

const NO_ANNOUNCEMENTS: Announcement[] = []

export function selectMaintenance(config: RemoteConfig | null): boolean {
	return config?.maintenance === true
}

export function selectAnnouncements(config: RemoteConfig | null): Announcement[] {
	return config?.announcements ?? NO_ANNOUNCEMENTS
}

export function selectPricing(config: RemoteConfig | null): Pricing | null {
	return config?.pricing ?? null
}

// undefined while loading, null when the section is missing or malformed.
export function useRemotePricingQuery(): UseQueryResult<Pricing | null> {
	return useRemoteConfigQuery(selectPricing)
}

export type AnnouncementPlatform = "web" | "desktop"

// Active ones for this platform, newest first. Title and message are the server's English plain text.
export function platformAnnouncements(announcements: readonly Announcement[], platform: AnnouncementPlatform): Announcement[] {
	return announcements
		.filter(announcement => announcement.active && announcement.platforms.some(value => value === platform || value === "all"))
		.sort((a, b) => b.timestamp - a.timestamp)
}

// One at a time: the newest not yet dismissed.
export function currentAnnouncement(candidates: readonly Announcement[], dismissed: readonly string[]): Announcement | undefined {
	const hidden = new Set(dismissed)

	return candidates.find(announcement => !hidden.has(announcement.uuid))
}

// Lives in kv, so a sign-out (which clears kv) brings dismissed announcements back.
const dismissedAnnouncements = kvPreference({
	key: "remoteConfig.dismissedAnnouncements.v1",
	schema: type("string[]"),
	fallback: []
})

export const DISMISSED_ANNOUNCEMENTS_QUERY_KEY = ["remoteConfig", "dismissedAnnouncements"] as const

// Read only while there is something to hide, so the common case does no kv work. A local read, so returning to the
// tab picks up a dismissal made in another tab.
export function useDismissedAnnouncementsQuery(enabled: boolean): UseQueryResult<string[]> {
	return useQuery({
		queryKey: DISMISSED_ANNOUNCEMENTS_QUERY_KEY,
		queryFn: dismissedAnnouncements.get,
		enabled,
		persister: noDiskPersister
	})
}

// Shown at once, written behind. The stored list keeps only ids the config still lists, so it cannot grow without
// bound.
export async function dismissAnnouncement(client: QueryClient, uuid: string, announcements: readonly Announcement[]): Promise<void> {
	const listed = new Set(announcements.map(announcement => announcement.uuid))
	const current = client.getQueryData<string[]>(DISMISSED_ANNOUNCEMENTS_QUERY_KEY) ?? []
	const next = [...current.filter(id => id !== uuid && listed.has(id)), uuid]

	client.setQueryData(DISMISSED_ANNOUNCEMENTS_QUERY_KEY, next)

	try {
		await dismissedAnnouncements.set(next)
	} catch (e) {
		log.warn("remoteConfig", "persisting a dismissed announcement failed", e)
	}
}
