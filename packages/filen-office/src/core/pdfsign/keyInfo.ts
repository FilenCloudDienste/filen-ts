import * as asn1js from "asn1js"
import { AlgorithmIdentifier, PublicKeyInfo, type Certificate } from "pkijs"
import { RSA_ENCRYPTION_OID, RSA_PSS_OID } from "./algorithms"

// A certificate's public key as WebCrypto imports it ("spki"). WebCrypto takes RSA keys only under the rsaEncryption
// identifier, so a key restricted to RSA-PSS (id-RSASSA-PSS) is presented as plain RSA: the key material is the same,
// and the signature algorithm is still checked against the restriction by the caller.

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
