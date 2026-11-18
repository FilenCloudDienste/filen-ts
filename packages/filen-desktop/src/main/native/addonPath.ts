import path from "node:path"
import { stagedDirName } from "../../shared/buildLayout.ts"

export interface AddonPathContext {
	packaged: boolean
	resourcesPath: string
	env: NodeJS.ProcessEnv
	appPath: string
	platform: NodeJS.Platform
	arch: string
	exists(file: string): boolean
}

// A file of build/native/<os>-<arch>: shipped beside the asar when packaged, else the staged copy. null when there is none.
export function nativeFilePath(ctx: Omit<AddonPathContext, "env">, file: string): string | null {
	const candidate = ctx.packaged
		? path.join(ctx.resourcesPath, "native", file)
		: path.join(ctx.appPath, "build", "native", stagedDirName(ctx.platform, ctx.arch), file)

	return ctx.exists(candidate) ? candidate : null
}

// The sync addon; in development FILEN_DESKTOP_NAPI takes precedence over the staged copy.
export function addonPath(ctx: AddonPathContext): string | null {
	const override = ctx.env["FILEN_DESKTOP_NAPI"]

	if (!ctx.packaged && override !== undefined && override.length > 0) {
		return ctx.exists(override) ? path.resolve(override) : null
	}

	return nativeFilePath(ctx, "sdk-rs.node")
}

// filen-mac.node, the macOS addon (quarantine, drag-out); null on other systems.
export function macAddonPath(ctx: Omit<AddonPathContext, "env">): string | null {
	return ctx.platform === "darwin" ? nativeFilePath(ctx, "filen-mac.node") : null
}
