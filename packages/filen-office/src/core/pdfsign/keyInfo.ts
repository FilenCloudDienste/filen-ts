import * as asn1js from "asn1js"
import { AlgorithmIdentifier, PublicKeyInfo, type Certificate } from "pkijs"

// A certificate's public key as WebCrypto imports it ("spki"). WebCrypto takes RSA keys only under the rsaEncryption
// identifier, so a key restricted to RSA-PSS (id-RSASSA-PSS) is presented as plain RSA: the key material is the same,
// and the signature algorithm is still checked against the restriction by the caller.

export const RSA_ENCRYPTION_OID = "1.2.840.113549.1.1.1"
export const RSA_PSS_OID = "1.2.840.113549.1.1.10"

export function webCryptoSpki(certificate: Certificate): Uint8Array {
	const info = certificate.subjectPublicKeyInfo

	const plain =
		info.algorithm.algorithmId === RSA_PSS_OID
			? new PublicKeyInfo({
					algorithm: new AlgorithmIdentifier({ algorithmId: RSA_ENCRYPTION_OID, algorithmParams: new asn1js.Null() }),
					subjectPublicKey: info.subjectPublicKey
				})
			: info

	return new Uint8Array(plain.toSchema().toBER(false))
}
