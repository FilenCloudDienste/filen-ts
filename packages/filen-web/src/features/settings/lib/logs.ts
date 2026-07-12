import type { LogEntry } from "@/lib/log"

// Plain single-line rendering shared by the on-screen list and the exported file: `[ISO time] LEVEL
// [scope] message`, uppercase level for a quick visual scan. Scoped to this tab's own in-memory ring
// buffer (src/lib/log.ts) — the SDK worker runs in a separate realm with its own module instance of
// the same ring buffer, which this does not reach; a future export could add a dedicated Comlink call
// to merge the two, but that is out of scope for this first ship.
export function formatLogEntry(entry: LogEntry): string {
	return `[${new Date(entry.t).toISOString()}] ${entry.level.toUpperCase()} [${entry.scope}] ${entry.msg}`
}

export function formatLogEntries(entries: readonly LogEntry[]): string {
	return entries.map(formatLogEntry).join("\n")
}

export function logsExportFilename(): string {
	return `filen-web-logs.${String(Date.now())}.txt`
}
