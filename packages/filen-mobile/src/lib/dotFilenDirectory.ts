import auth from "@/lib/auth"
import { AnyNormalDir, DirMeta_Tags, type Dir, type JsClientInterface } from "@filen/sdk-rs"
import { toSignalOpts } from "@/lib/signals"

async function findOrCreateDir(client: JsClientInterface, parent: AnyNormalDir, name: string, signal?: AbortSignal): Promise<Dir> {
	const lowerName = name.toLowerCase()
	const existing = (await client.listDir(parent, toSignalOpts(signal))).dirs.find(
		d => d.meta.tag === DirMeta_Tags.Decoded && d.meta.inner[0].name.trim().toLowerCase() === lowerName
	)

	return existing ?? (await client.createDir(parent, name, toSignalOpts(signal)))
}

// Every feature must resolve the same root-level ".filen" directory, so the name match lives here once.
export async function ensureDotFilenSubdirectory(name: string, signal?: AbortSignal): Promise<Dir> {
	const { authedSdkClient } = await auth.getSdkClients()
	const dotFilenDir = await findOrCreateDir(
		authedSdkClient,
		new AnyNormalDir.Root({
			uuid: authedSdkClient.root().uuid
		}),
		".filen",
		signal
	)

	return await findOrCreateDir(authedSdkClient, new AnyNormalDir.Dir(dotFilenDir), name, signal)
}
