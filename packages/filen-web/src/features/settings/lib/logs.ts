import type { LogEntry } from "@/lib/log"
import { SW_MSG_DUMP_LOGS } from "@/lib/sw/protocol"

// Every realm keeps its own ring (src/lib/log.ts is one module instance per realm). The page pulls the others on
// demand, never per entry: the SDK worker and the db worker over their api, the service worker over a message. The
// callers hand in lib/sdk/client.ts's `sdkApi` and lib/storage/adapter.ts's `storage`, which keeps this module free of
// worker start-up and lets tests stub each realm.
export interface LogSources {
	sdk: { dumpLogs: () => Promise<LogEntry[]> }
	storage: () => Promise<{ api: { dumpLogs: () => Promise<LogEntry[]> } }>
}

export interface RealmLogs {
	realm: string
	entries: readonly LogEntry[]
}

// A realm that does not answer in time (a busy or stale worker, an idle service worker starting up) adds nothing.
const PULL_TIMEOUT_MS = 2_000

// Plain single-line rendering shared by the on-screen list and the exported file: `[ISO time] LEVEL
// [scope] message`, uppercase level for a quick visual scan.
export function formatLogEntry(entry: LogEntry): string {
	return `[${new Date(entry.t).toISOString()}] ${entry.level.toUpperCase()} [${entry.scope}] ${entry.msg}`
}

export function formatLogEntries(entries: readonly LogEntry[]): string {
	return entries.map(formatLogEntry).join("\n")
}

export interface LogsExportContext {
	build: string
	userAgent: string
	exportedAt: Date
}

// The exported file opens with the build and browser it came from, so a report names its version without being asked.
export function logsExportText(entries: readonly LogEntry[], { build, userAgent, exportedAt }: LogsExportContext): string {
	return `Filen web ${build}\n${userAgent}\nExported ${exportedAt.toISOString()}\n\n${formatLogEntries(entries)}`
}

export function logsExportFilename(): string {
	return `filen-web-logs.${String(Date.now())}.txt`
}

// The page's own entries keep their scope; every other realm's carry it as `realm/scope`. Ordered by time, ties in
// the order the realms are given (the sort is stable).
export function mergeLogEntries(page: readonly LogEntry[], others: readonly RealmLogs[]): LogEntry[] {
	const merged = [...page]

	for (const { realm, entries } of others) {
		for (const entry of entries) {
			merged.push({ ...entry, scope: `${realm}/${entry.scope}` })
		}
	}

	return merged.sort((a, b) => a.t - b.t)
}

// `dump` gets a signal that aborts once the pull settles, so a source that answers late can drop what it holds.
async function pull(dump: (signal: AbortSignal) => Promise<LogEntry[]>): Promise<readonly LogEntry[]> {
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined

	try {
		return await Promise.race([
			dump(controller.signal),
			new Promise<readonly LogEntry[]>(resolve => {
				timer = setTimeout(() => {
					resolve([])
				}, PULL_TIMEOUT_MS)
			})
		])
	} catch {
		return []
	} finally {
		clearTimeout(timer)
		controller.abort()
	}
}

// The controlling service worker's ring, shared by every tab and gone when the browser stops an idle worker: best
// effort. An answer that is not an array counts as none; a worker that never answers has its port closed when the
// pull gives up.
function serviceWorkerLogs(signal: AbortSignal): Promise<LogEntry[]> {
	const controller = "serviceWorker" in navigator ? navigator.serviceWorker.controller : null

	if (controller === null) {
		return Promise.resolve([])
	}

	return new Promise(resolve => {
		const channel = new MessageChannel()

		function done(entries: LogEntry[]): void {
			signal.removeEventListener("abort", onAbort)
			channel.port1.onmessage = null
			channel.port1.close()
			resolve(entries)
		}

		function onAbort(): void {
			done([])
		}

		signal.addEventListener("abort", onAbort, { once: true })

		channel.port1.onmessage = (event: MessageEvent<unknown>) => {
			done(Array.isArray(event.data) ? (event.data as LogEntry[]) : [])
		}

		controller.postMessage({ type: SW_MSG_DUMP_LOGS }, [channel.port2])
	})
}

// This page's ring merged with the SDK worker's, the db worker's and the service worker's, all pulled at once. Not
// redacted, like the page's own entries: the user exports them on purpose, and the desktop shell redacts its export.
export async function collectLogs(page: readonly LogEntry[], sources: LogSources): Promise<LogEntry[]> {
	const [sdkWorker, dbWorker, serviceWorker] = await Promise.all([
		pull(() => sources.sdk.dumpLogs()),
		pull(async () => (await sources.storage()).api.dumpLogs()),
		pull(serviceWorkerLogs)
	])

	return mergeLogEntries(page, [
		{ realm: "sdk-worker", entries: sdkWorker },
		{ realm: "db-worker", entries: dbWorker },
		{ realm: "service-worker", entries: serviceWorker }
	])
}
