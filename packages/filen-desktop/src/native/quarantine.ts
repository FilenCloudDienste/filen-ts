// Marks what a download wrote as coming from the internet (macOS quarantine, Windows Mark of the Web) before the page
// can open it. Sync never goes through here.
export interface Quarantine {
	mark(files: readonly string[], directories: readonly string[]): Promise<void>
}

// filen-mac.node: sets com.apple.quarantine (agent "Filen", other download) on each path through LaunchServices,
// which fills in the flags, timestamp and event id. Marks every path, then throws naming the first that failed.
export interface MacAddon {
	quarantine(paths: string[]): void
}

// Internet zone; Windows reads the stream on open (SmartScreen, Office protected view).
export const ZONE_IDENTIFIER = "[ZoneTransfer]\r\nZoneId=3\r\n"

export function zoneIdentifierPath(path: string): string {
	return `${path}:Zone.Identifier`
}

export const noQuarantine: Quarantine = {
	mark: () => Promise.resolve()
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
				mark: (files, directories) => {
					if (files.length + directories.length === 0) {
						return Promise.resolve()
					}

					try {
						macAddon.quarantine([...files, ...directories])

						return Promise.resolve()
					} catch (error) {
						return Promise.reject(error instanceof Error ? error : new Error(String(error)))
					}
				}
			}
		}
		// Mark of the Web applies to files; a directory's stream is never read.
		case "win32": {
			return {
				mark: async files => {
					const results = await Promise.allSettled(files.map(file => fs.writeFile(zoneIdentifierPath(file), ZONE_IDENTIFIER)))
					let first: string | null = null
					let failures = 0

					results.forEach((result, index) => {
						if (result.status === "rejected") {
							const reason: unknown = result.reason

							failures++
							first ??= `${files[index] ?? ""}: ${reason instanceof Error ? reason.message : String(reason)}`
						}
					})

					if (first !== null) {
						throw new Error(failures > 1 ? `${first} (and ${String(failures - 1)} more)` : first)
					}
				}
			}
		}
		default:
			return noQuarantine
	}
}
