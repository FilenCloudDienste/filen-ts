// Where the 3.0.47 -> N update runs (gap 1; scripts/ci/legacy.ts OLDER_PIN), for scripts/ci/e2ePlan.ts. No
// dependencies: the planner runs before anything is installed.
//
//   install depth  3.0.47 installed, its own updater (hooked to the loopback feed) installs N, no sign-in: Windows NSIS
//                  and Linux deb (the deb proves the @filendesktop link: its relaunch runs that path). At release, and
//                  on one night a week
//   deep           chain L run from 3.0.47 (scripts/ci/e2e/chains/legacy.ts with the older pin): Windows NSIS, macOS
//                  dmg and Linux deb, at release only (and by hand). One real 3.0.47 sign-in a run, the rest seeded
//
// A deep entry runs the deep chain instead of the install-depth one, which the chain's update step includes (L1).
// By hand, SCENARIOS names `older` to run it.

export const OLDER_SCENARIO = "older"
export const OLDER_INSTALL_ENTRIES: readonly string[] = ["win-x64-nsis", "linux-x64-deb"]
export const OLDER_DEEP_ENTRIES: readonly string[] = ["win-x64-nsis", "mac-arm64-dmg", "linux-x64-deb"]
// The night of the week (UTC, 0 = Sunday) the nightly also updates from 3.0.47.
export const OLDER_NIGHT = 3

// Day 0 of the Unix epoch was a Thursday.
export function weekday(day: number): number {
	return (((day + 4) % 7) + 7) % 7
}

export interface OlderInput {
	profile: "release" | "nightly" | "custom"
	scenarios: readonly string[]
	// The legacy scenarios are not switched off (LEGACY).
	legacy: boolean
	spike: string
	day: number
}

// Whether the run updates from 3.0.47 at all: at release and on its night whenever the legacy scenario runs, by hand
// when SCENARIOS names it.
export function runsOlder({ profile, scenarios, legacy, spike, day }: OlderInput): boolean {
	if (spike !== "" || !legacy) {
		return false
	}

	switch (profile) {
		case "release":
			return scenarios.includes("legacy")
		case "nightly":
			return scenarios.includes("legacy") && weekday(day) === OLDER_NIGHT
		case "custom":
			return scenarios.includes(OLDER_SCENARIO)
	}
}

// One entry's part: deep where the entry runs deep in this run (and never at night), else at install depth on the
// install entries.
export function olderFor(
	id: string,
	older: boolean,
	deep: boolean,
	profile: OlderInput["profile"]
): { older: boolean; deepOlder: boolean } {
	const deepOlder = older && deep && profile !== "nightly" && OLDER_DEEP_ENTRIES.includes(id)

	return { older: deepOlder || (older && OLDER_INSTALL_ENTRIES.includes(id)), deepOlder }
}
