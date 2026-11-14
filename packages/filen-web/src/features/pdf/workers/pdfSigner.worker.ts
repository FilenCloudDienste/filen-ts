/// <reference lib="webworker" />
import * as Comlink from "comlink"
import { createPdfSignerApi, type PdfSignerApi } from "@/features/pdf/workers/pdfSignerCore"

// The certificate signer: one short-lived worker per signing, holding the PKCS#12 key (pdfSignerCore.ts). The page
// terminates it once the signature is made or the signing is cancelled; nothing it holds outlives it.
const core = createPdfSignerApi(crypto.subtle)

const api: PdfSignerApi = {
	load: source => core.load(source),
	unlock: password => core.unlock(password),
	sign: async digest => {
		const cms = await core.sign(digest)

		return Comlink.transfer(cms, [cms.buffer])
	}
}

Comlink.expose(api)
