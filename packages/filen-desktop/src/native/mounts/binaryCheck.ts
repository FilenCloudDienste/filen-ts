import { execFile } from "node:child_process"

// Developer ID builds of the app, and the rclone signed into them (build/afterPack.ts).
export const TEAM_REQUIREMENT = '=anchor apple generic and certificate leaf[subject.OU] = "7YTW5D2K7P"'

// Runs a program without a shell; resolves with whether it exited 0.
export type RunProgram = (file: string, args: readonly string[]) => Promise<boolean>

export const runProgram: RunProgram = (file, args) =>
	new Promise(resolve => {
		execFile(file, args, { windowsHide: true }, error => {
			resolve(error === null)
		})
	})

export interface BinaryCheckContext {
	platform: NodeJS.Platform
	// This process's executable: in a signed app, the app's helper.
	execPath: string
	run: RunProgram
	log(message: string): void
}

// Whether the bundled rclone may run. Only macOS checks anything here: codesign rewrites the binary after the build, so
// it must carry the app's team signature, checked once per binary per host run; an app that is not itself team-signed
// (development, a local unsigned package) has no signature to hold rclone to. Elsewhere this passes every binary:
// Linux's guarantee is the sha256 main bakes in at build time and the SDK checks before each start (rclonePath.ts);
// Windows checks nothing at run time (the per-machine install directory protects it, and the release's package check
// verifies rclone's Authenticode signature).
export function createBinaryCheck(ctx: BinaryCheckContext): (binary: string) => Promise<boolean> {
	if (ctx.platform !== "darwin") {
		return () => Promise.resolve(true)
	}

	const verify = (target: string) => ctx.run("/usr/bin/codesign", ["--verify", "--strict", "-R", TEAM_REQUIREMENT, target])
	const verdicts = new Map<string, Promise<boolean>>()
	let appSigned: Promise<boolean> | null = null

	return binary => {
		let verdict = verdicts.get(binary)

		if (verdict === undefined) {
			appSigned ??= verify(ctx.execPath).then(signed => {
				if (!signed) {
					ctx.log("mounts: this app is not team-signed; rclone's signature is not checked")
				}

				return signed
			})
			verdict = appSigned.then(signed => !signed || verify(binary))
			verdicts.set(binary, verdict)
		}

		return verdict
	}
}
