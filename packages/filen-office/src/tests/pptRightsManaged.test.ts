import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CfbFile, cfbBytes } from "../core/cfb/index"
import {
	dataSpaceDefinitionStream,
	dataSpaceMapStream,
	dataSpaceVersionStream,
	transformPrimaryStream
} from "../core/encryption/dataSpaces"
import { bytesSource } from "../core/opc/index"
import { pptToPptx } from "../core/ppt/toPptx"
import { CORPUS_DIR } from "./corpusDir"

// An Office 2003 IRM presentation ([MS-OFFCRYPTO] §2.2.11: its content in \x09DRMContent behind a DRM transform the
// \x06DataSpaces storage maps it to, with or without the stub "PowerPoint Document" Office writes beside it for
// readers without IRM) is refused rightsManaged, never opened as the stub.

const STREAMS = ["PowerPoint Document", "Current User", "\u0005SummaryInformation", "\u0005DocumentSummaryInformation"]

function dataSpaces(): { path: string[]; bytes: Uint8Array }[] {
	return [
		{ path: ["\u0006DataSpaces", "Version"], bytes: dataSpaceVersionStream() },
		{
			path: ["\u0006DataSpaces", "DataSpaceMap"],
			bytes: dataSpaceMapStream([{ components: ["\u0009DRMContent"], dataSpace: "DRMEncryptedDataSpace" }])
		},
		{
			path: ["\u0006DataSpaces", "DataSpaceInfo", "DRMEncryptedDataSpace"],
			bytes: dataSpaceDefinitionStream(["DRMEncryptedTransform"])
		},
		{
			path: ["\u0006DataSpaces", "TransformInfo", "DRMEncryptedTransform", "\u0006Primary"],
			bytes: transformPrimaryStream("{C73DFACD-061F-43B0-8B64-0C620D2A8B50}", "Microsoft.Metadata.DRMTransform", false)
		},
		{ path: ["\u0009DRMContent"], bytes: new Uint8Array(4104).fill(0xa5) }
	]
}

async function stub(): Promise<{ path: string[]; bytes: Uint8Array }[]> {
	const cfb = await CfbFile.open(bytesSource(new Uint8Array(readFileSync(join(CORPUS_DIR, "ppt/tika__testPPT.ppt")))))
	const out: { path: string[]; bytes: Uint8Array }[] = []

	for (const name of STREAMS) if (cfb.entry(name) !== undefined) out.push({ path: [name], bytes: await cfb.read(name) })

	return out
}

describe("an IRM-protected .ppt", () => {
	it.skipIf(!existsSync(join(CORPUS_DIR, "ppt/tika__testPPT.ppt")))(
		"is refused rightsManaged, with or without the stub presentation beside it",
		async () => {
			for (const streams of [[...(await stub()), ...dataSpaces()], dataSpaces()])
				expect(await pptToPptx(bytesSource(await cfbBytes(streams)))).toMatchObject({ kind: "refused", reason: "rightsManaged" })
		}
	)
})
