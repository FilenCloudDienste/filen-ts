/// <reference lib="webworker" />
import { servePdfSigner } from "@/features/pdf/workers/pdfSignerCore"

// The certificate signer: one short-lived worker per signing, holding the PKCS#12 key (pdfSignerCore.ts). The page
// terminates it once the signature is made or the signing is cancelled; nothing it holds outlives it. Without the
// legacy ciphers: a container that needs them is read again by pdfSignerLegacy.worker.ts.
servePdfSigner(crypto.subtle, null)
