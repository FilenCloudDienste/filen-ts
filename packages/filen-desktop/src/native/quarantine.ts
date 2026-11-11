// Marks what a download wrote as coming from the internet (macOS quarantine, Windows Mark of the Web) before the page
// can open it. Sync never goes through here.
export interface Quarantine {
	mark(files: readonly string[], directories: readonly string[]): Promise<void>
}

// filen-mac.node: sets com.apple.quarantine (agent "Filen", other download) on each path through LaunchServices,
// which fills in the flags, timestamp and event id, off the JS thread and one call at a time. Marks every path, then
// rejects naming the first that failed, with `failures` counting them.
export interface MacAddon {
	quarantine(paths: string[]): Promise<void>
}

// Paths per addon call: the addon reads its argument on the JS thread, so a batch's share of it stays short.
export const MAC_QUARANTINE_BATCH = 1024

// Zone.Identifier writes in flight per mark, so a large batch neither floods libuv's pool nor allocates every write up
// front.
export const ZONE_WRITES_IN_FLIGHT = 8

// Internet zone; Windows reads the stream on open (SmartScreen, Office protected view).
export const ZONE_IDENTIFIER = "[ZoneTransfer]\r\nZoneId=3\r\n"

export function zoneIdentifierPath(path: string): string {
	return `${path}:Zone.Identifier`
}

export const noQuarantine: Quarantine = {
	mark: () => Promise.resolve()
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// Names the first failure and how many more there were.
function failure(first: string, failures: number): Error {
	return new Error(failures > 1 ? `${first} (and ${String(failures - 1)} more)` : first)
}

function failuresOf(error: unknown): number {
	const failures: unknown = error instanceof Error && "failures" in error ? error.failures : undefined

	return typeof failures === "number" && failures > 0 ? failures : 1
}

export function createQuarantine(deps: {
	platform: NodeJS.Platform
	macAddon: MacAddon | null
	fs: { writeFile(path: string, data: string): Promise<void> }
	log: { warn(message: string): void }
}): Quarantine {
	const { macAddon, fs, log } = deps

	switch (deps.platform) {
		case "darwin": {
			if (macAddon === null) {
				log.warn("no filen-mac.node: downloads are not quarantined")

				return noQuarantine
			}

			return {
				mark: async (files, directories) => {
					const paths = [...files, ...directories]
					let first: string | null = null
					let failures = 0

					for (let start = 0; start < paths.length; start += MAC_QUARANTINE_BATCH) {
						try {
							await macAddon.quarantine(paths.slice(start, start + MAC_QUARANTINE_BATCH))
						} catch (error) {
							first ??= messageOf(error)
							failures += failuresOf(error)
						}
					}

					if (first !== null) {
						throw failure(first, failures)
					}
				}
			}
		}
		// Mark of the Web applies to files; a directory's stream is never read.
		case "win32": {
			return {
				mark: async files => {
					let next = 0
					let first: string | null = null
					let failures = 0

					const worker = async () => {
						while (next < files.length) {
							const file = files[next++] ?? ""

							try {
								await fs.writeFile(zoneIdentifierPath(file), ZONE_IDENTIFIER)
							} catch (error) {
								failures++
								first ??= `${file}: ${messageOf(error)}`
							}
						}
					}

					await Promise.all(Array.from({ length: Math.min(ZONE_WRITES_IN_FLIGHT, files.length) }, worker))

					if (first !== null) {
						throw failure(first, failures)
					}
				}
			}
		}
		default:
			return noQuarantine
	}
}
