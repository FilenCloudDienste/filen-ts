import { keepPreviousData, useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { noDiskPersister } from "@/queries/persist"
import { queryClient } from "@/queries/client"
import { VIDEO_CATALOG_KEY_PREFIX } from "@/features/videos/lib/index"
import type { GridPage, GridQuery, HomeQuery, HomeResult, SearchResult } from "@/workers/videoIndex/catalog.logic"
import type { VideoCardModel } from "@/features/videos/lib/homeRows.logic"
import type { VideoTitleView } from "@/workers/videoIndex/view.logic"

// The library catalog a screen at a time, from the SDK worker (no request): home rows, grid pages, search results and
// single titles. Fetched again when the catalog or the watch state it reads changes; a page or result list scrolled
// away is dropped soon, so the page holds only what is (nearly) on screen.

// Cards per grid page.
export const GRID_PAGE_SIZE = 96

// How long a query nobody shows stays: rows a little longer, so Back to the home paints at once.
const HOME_GC_MS = 5 * 60_000
const PAGE_GC_MS = 15_000

export function useCatalogHomeQuery(query: Omit<HomeQuery, "heroPreviousId">, heroPreviousId: () => string | null, enabled: boolean) {
	return useQuery({
		queryKey: [...VIDEO_CATALOG_KEY_PREFIX, "home", query.roots.join(","), query.now, query.heroSeed] as const,
		queryFn: (): Promise<HomeResult> => sdkApi.videoCatalogHome({ ...query, heroPreviousId: heroPreviousId() }),
		enabled,
		staleTime: Infinity,
		gcTime: HOME_GC_MS,
		placeholderData: keepPreviousData,
		persister: noDiskPersister
	})
}

function gridPageKey(query: GridQuery, page: number) {
	return [...VIDEO_CATALOG_KEY_PREFIX, "grid", JSON.stringify(query), page] as const
}

let nextGridTicket = 0

// A page nobody shows any more (a new sort, filter or search, the grid left) is abandoned in the worker, which stops
// building its order unless another call waits on it.
function fetchGridPage(query: GridQuery, page: number, signal: AbortSignal): Promise<GridPage> {
	const ticket = nextGridTicket++

	signal.addEventListener(
		"abort",
		() => {
			void sdkApi.videoCatalogAbandon(ticket)
		},
		{ once: true }
	)

	return sdkApi.videoCatalogGrid(query, page * GRID_PAGE_SIZE, GRID_PAGE_SIZE, ticket)
}

function gridPageOptions(query: GridQuery, page: number, enabled: boolean) {
	return {
		queryKey: gridPageKey(query, page),
		queryFn: ({ signal }: { signal: AbortSignal }): Promise<GridPage> => fetchGridPage(query, page, signal),
		enabled,
		staleTime: Infinity,
		gcTime: PAGE_GC_MS,
		persister: noDiskPersister
	}
}

// A grid card from a page already fetched (the one holding the keyboard cursor is rendered, so its page is held).
export function cachedGridCard(query: GridQuery, index: number): VideoCardModel | undefined {
	return queryClient.getQueryData<GridPage>(gridPageKey(query, Math.floor(index / GRID_PAGE_SIZE)))?.cards[index % GRID_PAGE_SIZE]
}

// A grid card, its page fetched when not held (a cursor move ahead of the rows on screen).
export async function fetchGridCard(query: GridQuery, index: number): Promise<VideoCardModel | undefined> {
	const page: GridPage = await queryClient.query(gridPageOptions(query, Math.floor(index / GRID_PAGE_SIZE), true))

	return page.cards[index % GRID_PAGE_SIZE]
}

// The grid's first page: its counts and options come with every page, and this one is always wanted.
export function useCatalogGridHeadQuery(query: GridQuery, enabled: boolean): UseQueryResult<GridPage> {
	return useQuery({ ...gridPageOptions(query, 0, enabled), placeholderData: keepPreviousData })
}

export interface GridPages {
	// The first page's index; `pages[i]` is page `first + i`, undefined until it arrives.
	first: number
	pages: readonly (GridPage | undefined)[]
}

// Stable, so the combined result keeps its identity while no page changes.
function combinePages(results: readonly { data: GridPage | undefined }[]): readonly (GridPage | undefined)[] {
	return results.map(result => result.data)
}

// The pages holding the cards in [first, last]. Keeps its identity while no page changes.
export function useCatalogGridPages(query: GridQuery, first: number, last: number, enabled: boolean): GridPages {
	const from = Math.floor(Math.max(0, first) / GRID_PAGE_SIZE)
	const pages: number[] = []

	for (let page = from; page <= Math.floor(Math.max(0, last) / GRID_PAGE_SIZE); page++) {
		pages.push(page)
	}

	const data = useQueries({
		queries: pages.map(page => gridPageOptions(query, page, enabled && last >= first)),
		combine: combinePages
	})

	return { first: from, pages: data }
}

// The card at `index`, from pages fetched.
export function gridPageCard({ first, pages }: GridPages, index: number): VideoCardModel | undefined {
	return pages[Math.floor(index / GRID_PAGE_SIZE) - first]?.cards[index % GRID_PAGE_SIZE]
}

// A search result with the query it answers: a result kept from an earlier query (while the next one is pending) is
// told apart by its query, which a deferred render keeps in step with its groups.
export interface CatalogSearchResult extends SearchResult {
	query: string
}

export function useCatalogSearchQuery(query: string): UseQueryResult<CatalogSearchResult> {
	return useQuery({
		queryKey: [...VIDEO_CATALOG_KEY_PREFIX, "search", query] as const,
		queryFn: async (): Promise<CatalogSearchResult> => ({ ...(await sdkApi.videoCatalogSearch(query)), query }),
		enabled: query.trim().length > 0,
		staleTime: Infinity,
		gcTime: PAGE_GC_MS,
		placeholderData: keepPreviousData,
		persister: noDiskPersister
	})
}

export function catalogTitleQueryKey(id: string) {
	return [...VIDEO_CATALOG_KEY_PREFIX, "title", id] as const
}

// One title's view (hidden ones too); null when the catalog doesn't hold it.
export function useCatalogTitleQuery(id: string): UseQueryResult<VideoTitleView | null> {
	return useQuery({
		queryKey: catalogTitleQueryKey(id),
		queryFn: () => sdkApi.videoCatalogTitle(id),
		staleTime: Infinity,
		gcTime: HOME_GC_MS,
		persister: noDiskPersister
	})
}

export function useCatalogHiddenQuery(enabled: boolean): UseQueryResult<VideoTitleView[]> {
	return useQuery({
		queryKey: [...VIDEO_CATALOG_KEY_PREFIX, "hidden"] as const,
		queryFn: () => sdkApi.videoCatalogHidden(),
		enabled,
		staleTime: Infinity,
		gcTime: PAGE_GC_MS,
		persister: noDiskPersister
	})
}

// The library's series, for a correction that moves an item into one or merges a series.
export function useCatalogSeriesQuery(enabled: boolean): UseQueryResult<{ id: string; title: string }[]> {
	return useQuery({
		queryKey: [...VIDEO_CATALOG_KEY_PREFIX, "series"] as const,
		queryFn: () => sdkApi.videoCatalogSeries(),
		enabled,
		staleTime: Infinity,
		gcTime: PAGE_GC_MS,
		persister: noDiskPersister
	})
}
