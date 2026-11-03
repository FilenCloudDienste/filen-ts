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
//   update-kill  N-1 -> N with the installer killed mid-install, install depth (scripts/ci/e2e/updateKill.ts)
//   older      3.0.47 -> N through 3.0.47's own updater, hooked to the local feed (scripts/ci/e2e/update.ts)
//   spike-s1   can the packaged 3.0.53 and N be driven over their debugging ports (scripts/ci/e2e/spikes/s1.ts)
//   spike-s7   can Filen in Finder be switched on with nobody at the Mac (scripts/ci/e2e/spikes/s7.ts)
//
// At --depth deep, both also sign in and drive the apps around the update (scripts/ci/e2e/chains/previous.ts and
// legacy.ts).
//
//   node scripts/ci/e2e.ts --scenario <previous|legacy|older|update-kill|spike-s1|spike-s7> --platform <win|mac|linux> --arch <x64|arm64>
//       --format <nsis|dmg|deb|rpm|AppImage> --next <dir> --next-version <v> [--prev <dir> --prev-version <v>] [--signed]
//       [--depth <install|deep>] [--artifacts <dir>]
//
// The update scenarios at install depth need Node built-ins only; deep chains and spikes load playwright-core (and deep
// chains rclone's pinned release), so they need the package's dependencies installed.

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
		depth: { type: "string", default: "install" },
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

const scenario = oneOf("scenario", values.scenario, ["previous", "legacy", "older", "update-kill", "spike-s1", "spike-s7"] as const)
const platform = oneOf<Platform>("platform", values.platform, ["win", "mac", "linux"])
const arch = oneOf<Arch>("arch", values.arch, ["x64", "arm64"])
const format = oneOf<Format>("format", values.format, ["nsis", "dmg", "deb", "rpm", "AppImage"])
const depth = oneOf("depth", values.depth, ["install", "deep"] as const)
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
		case "legacy":
		case "older": {
			const options = {
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
			}

			if (depth === "install") {
				await runUpdate(options)
			} else if (scenario === "previous") {
				const { runPreviousDeep } = await import("./e2e/chains/previous.ts")

				await runPreviousDeep(options, path.resolve(values.artifacts))
			} else {
				const { runLegacyDeep } = await import("./e2e/chains/legacy.ts")

				await runLegacyDeep(options, path.resolve(values.artifacts))
			}

			return
		}

		case "update-kill": {
			const { runUpdateKill } = await import("./e2e/updateKill.ts")

			await runUpdateKill({
				target,
				platform,
				arch,
				format,
				nextDir,
				nextVersion,
				prevDir: path.resolve(required("prev", values.prev)),
				prevVersion: required("prev-version", values["prev-version"]),
				signed,
				work,
				artifacts: path.resolve(values.artifacts)
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

// Every wait is bounded, but the apps are unref'd children: this keeps the event loop alive until main() settles, so a
// scenario can only end by finishing or failing, never by Node finding nothing left to run (exit 13).
const keepAlive = setInterval(() => undefined, 60_000)

try {
	await main()
} catch (error) {
	console.error(
		`::error::${scenario} ${platform} ${arch} ${format}: ${error instanceof TestFailure ? error.message : errorMessage(error)}`
	)
	process.exit(1)
} finally {
	clearInterval(keepAlive)
}
