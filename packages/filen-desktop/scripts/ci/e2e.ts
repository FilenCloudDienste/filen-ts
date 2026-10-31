import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { runUpdate } from "./e2e/update.ts"
import { errorMessage, TestFailure } from "./support.ts"
import { targetFor, type Arch, type Format, type Platform } from "./targets.ts"

// Desktop e2e on a runner of one platform and architecture, for one install format (see
// .github/workflows/desktop-e2e.yml).
//
//   previous   N-1 -> N through the app's own updater (scripts/ci/e2e/update.ts)
//   legacy     3.0.53 -> N through 3.0.53's own updater (scripts/ci/e2e/update.ts)
//   spike-s1   can the packaged 3.0.53 and N be driven over their debugging ports (scripts/ci/e2e/spikes/s1.ts)
//   spike-s7   can Filen in Finder be switched on with nobody at the Mac (scripts/ci/e2e/spikes/s7.ts)
//
//   node scripts/ci/e2e.ts --scenario <previous|legacy|spike-s1|spike-s7> --platform <win|mac|linux> --arch <x64|arm64>
//       --format <nsis|dmg|deb|rpm|AppImage> --next <dir> --next-version <v> [--prev <dir> --prev-version <v>] [--signed]
//       [--artifacts <dir>]
//
// The update scenarios need Node built-ins only; the spikes load playwright-core, so they need the package's
// dependencies installed.

const { values } = parseArgs({
	options: {
		scenario: { type: "string" },
		platform: { type: "string" },
		arch: { type: "string" },
		format: { type: "string" },
		next: { type: "string" },
		"next-version": { type: "string" },
		prev: { type: "string" },
		"prev-version": { type: "string" },
		signed: { type: "boolean", default: false },
		work: { type: "string", default: path.join(os.tmpdir(), "filen-e2e") },
		artifacts: { type: "string", default: "e2e-artifacts" }
	}
})

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T {
	const match = allowed.find(candidate => candidate === value)

	if (match === undefined) {
		console.error(`--${name} must be one of ${allowed.join(", ")}`)
		process.exit(2)
	}

	return match
}

function required(name: string, value: string | undefined): string {
	if (value === undefined || value === "") {
		console.error(`--${name} is required`)
		process.exit(2)
	}

	return value
}

const scenario = oneOf("scenario", values.scenario, ["previous", "legacy", "spike-s1", "spike-s7"] as const)
const platform = oneOf<Platform>("platform", values.platform, ["win", "mac", "linux"])
const arch = oneOf<Arch>("arch", values.arch, ["x64", "arm64"])
const format = oneOf<Format>("format", values.format, ["nsis", "dmg", "deb", "rpm", "AppImage"])
const nextDir = path.resolve(required("next", values.next))
const nextVersion = required("next-version", values["next-version"])
const signed = values.signed
const work = path.resolve(values.work)

if (process.platform !== { win: "win32", mac: "darwin", linux: "linux" }[platform]) {
	console.error(`--platform ${platform} does not match this runner (${process.platform})`)
	process.exit(2)
}

async function main(): Promise<void> {
	const target = targetFor(platform, arch, format)

	switch (scenario) {
		case "previous":
		case "legacy": {
			await runUpdate({
				scenario,
				target,
				platform,
				arch,
				format,
				nextDir,
				nextVersion,
				prevDir: scenario === "previous" ? path.resolve(required("prev", values.prev)) : null,
				prevVersion: scenario === "previous" ? required("prev-version", values["prev-version"]) : null,
				signed,
				work
			})

			return
		}

		case "spike-s1": {
			const { runS1 } = await import("./e2e/spikes/s1.ts")

			await runS1({ target, nextDir, nextVersion, signed, work, artifacts: path.resolve(values.artifacts) })

			return
		}

		case "spike-s7": {
			const { runS7 } = await import("./e2e/spikes/s7.ts")

			await runS7({ target, nextDir, nextVersion, signed, work, artifacts: path.resolve(values.artifacts) })

			return
		}
	}
}

try {
	await main()
} catch (error) {
	console.error(
		`::error::${scenario} ${platform} ${arch} ${format}: ${error instanceof TestFailure ? error.message : errorMessage(error)}`
	)
	process.exit(1)
}
