/// <reference lib="webworker" />
import forge from "node-forge"
import { servePdfSigner } from "@/features/pdf/workers/pdfSignerCore"

// The certificate signer for containers older exports write (3DES or RC2 with the PKCS#12 key derivation), which
// WebCrypto cannot decrypt: pdfSigner.worker.ts with node-forge's ciphers. Started only when that one answers that the
// container needs them, so no other signing loads node-forge.
servePdfSigner(crypto.subtle, forge)
