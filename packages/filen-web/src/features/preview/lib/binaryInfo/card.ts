import type { TFunction } from "i18next"
import { formatBytes } from "@filen/shared"
import type { CmsSignerSummary } from "@filen/office/core/pdfsign"
import type { MetadataField, MetadataSectionData } from "@/features/preview/lib/metadataCard.types"
import type { BinaryInfo, BinarySignature, ElfInfo, MachOInfo, PeInfo } from "@/features/preview/lib/binaryInfo/types"
import { formatDateTime } from "@/lib/formatDate"

// The facts of an executable or disk image as a MetadataCard shows them.

export interface BinaryCard {
	readonly subtitle: string
	readonly sections: readonly MetadataSectionData[]
}

type Fields = MetadataField[]

function add(fields: Fields, label: string, value: string | null | undefined): void {
	if (value !== null && value !== undefined && value !== "") fields.push({ label, value })
}

function yesNo(t: TFunction<"preview">, value: boolean): string {
	return t(value ? "previewBinaryYes" : "previewBinaryNo")
}

function signatureFields(t: TFunction<"preview">, signature: BinarySignature, signer: CmsSignerSummary | null): Fields {
	const fields: Fields = []

	switch (signature.state) {
		case "none":
			add(fields, t("previewBinarySignature"), t("previewBinarySignatureNone"))
			break
		case "unreadable":
			add(fields, t("previewBinarySignature"), t("previewBinarySignatureUnreadable"))
			break
		case "present":
			if (signature.der === null) {
				add(fields, t("previewBinarySignature"), t("previewBinarySignatureAdHoc"))
			} else if (signer === null) {
				add(fields, t("previewBinarySignature"), t("previewBinarySignatureUnreadable"))
			} else {
				add(fields, t("previewBinarySignature"), t("previewBinarySignaturePresent"))
				add(fields, t("previewBinarySigner"), signer.subject)
				add(fields, t("previewBinaryIssuer"), signer.issuer)
				add(fields, t("previewBinarySigned"), signer.signedAt === null ? null : formatDateTime(signer.signedAt))
			}

			break
	}

	return fields
}

function peCard(t: TFunction<"preview">, info: PeInfo, signer: CmsSignerSummary | null): BinaryCard {
	const kind = {
		executable: t("previewBinaryPeExecutable"),
		library: t("previewBinaryPeLibrary"),
		driver: t("previewBinaryPeDriver"),
		efi: t("previewBinaryPeEfi")
	}[info.kind]
	const facts: Fields = []
	const product: Fields = []

	add(facts, t("previewBinarySubsystem"), info.subsystem)
	add(
		facts,
		t("previewBinaryBuilt"),
		info.built === null ? null : t("previewBinaryBuiltValue", { date: formatDateTime(info.built * 1000) })
	)

	if (info.managed) add(facts, t("previewBinaryManaged"), yesNo(t, true))

	const version = info.version

	if (version !== null) {
		add(product, t("previewBinaryProduct"), version.productName)
		add(product, t("previewBinaryCompany"), version.companyName)
		add(product, t("previewBinaryDescription"), version.fileDescription)
		add(product, t("previewBinaryFileVersion"), version.fileVersion)
		add(product, t("previewBinaryProductVersion"), version.productVersion)
		add(product, t("previewBinaryCopyright"), version.copyright)
		add(product, t("previewBinaryOriginalName"), version.originalFilename)
	}

	return {
		subtitle: t("previewBinaryKindDetail", { kind, detail: `${info.bits === 64 ? "PE32+" : "PE32"}, ${info.machine}` }),
		sections: [{ fields: facts }, { fields: signatureFields(t, info.signature, signer) }, { fields: product }]
	}
}

function elfCard(t: TFunction<"preview">, info: ElfInfo): BinaryCard {
	const kind = {
		executable: t("previewBinaryElfExecutable"),
		pie: t("previewBinaryElfPie"),
		sharedObject: t("previewBinaryElfSharedObject"),
		relocatable: t("previewBinaryElfRelocatable"),
		core: t("previewBinaryElfCore"),
		other: t("previewBinaryElfOther")
	}[info.kind]
	const facts: Fields = []

	add(facts, t("previewBinaryByteOrder"), t(info.endian === "little" ? "previewBinaryLittleEndian" : "previewBinaryBigEndian"))
	add(facts, t("previewBinaryAbi"), info.abi)

	if (info.interpreter !== null) facts.push({ label: t("previewBinaryInterpreter"), value: info.interpreter, mono: true })

	return {
		subtitle: t("previewBinaryKindDetail", { kind, detail: `${String(info.bits)}-bit, ${info.machine}` }),
		sections: [{ fields: facts }]
	}
}

function machOCard(t: TFunction<"preview">, info: MachOInfo, signer: CmsSignerSummary | null): BinaryCard {
	const kind = {
		executable: t("previewBinaryMachOExecutable"),
		library: t("previewBinaryMachOLibrary"),
		bundle: t("previewBinaryMachOBundle"),
		object: t("previewBinaryMachOObject"),
		kernelExtension: t("previewBinaryMachOKernelExtension"),
		other: t("previewBinaryMachOOther")
	}[info.kind]
	const architectures = info.slices.map(slice => slice.cpu).join(", ")
	const detail =
		info.slices.length > 1
			? t("previewBinaryUniversal", { architectures })
			: `${String(info.slices[0]?.bits ?? 64)}-bit, ${architectures}`
	const facts: Fields = []

	add(
		facts,
		t("previewBinaryPlatform"),
		info.platform === null || info.minimumOs === null
			? info.platform
			: t("previewBinaryPlatformValue", { platform: info.platform, version: info.minimumOs })
	)

	return {
		subtitle: t("previewBinaryKindDetail", { kind, detail }),
		sections: [{ fields: facts }, { fields: signatureFields(t, info.signature, signer) }]
	}
}

export function binaryCard(t: TFunction<"preview">, info: BinaryInfo, signer: CmsSignerSummary | null): BinaryCard {
	switch (info.format) {
		case "pe":
			return peCard(t, info, signer)
		case "elf":
			return elfCard(t, info)
		case "macho":
			return machOCard(t, info, signer)
		case "dmg": {
			const fields: Fields = []

			add(fields, t("previewBinaryEncrypted"), yesNo(t, info.encrypted))
			add(fields, t("previewBinaryDataSize"), info.dataSize === null ? null : formatBytes(info.dataSize))
			add(fields, t("previewBinaryPartitions"), info.partitions.join("\n"))

			return { subtitle: t("previewBinaryDmg"), sections: [{ fields }] }
		}
		case "iso": {
			const fields: Fields = []

			add(fields, t("previewBinaryVolume"), info.volume)
			add(fields, t("previewBinarySystem"), info.system)
			add(fields, t("previewBinaryPublisher"), info.publisher)
			add(fields, t("previewBinaryApplication"), info.application)
			add(fields, t("previewBinaryCreated"), info.created)
			add(fields, t("previewBinaryVolumeSize"), info.volumeBytes === null ? null : formatBytes(info.volumeBytes))
			add(fields, t("previewBinaryBootable"), yesNo(t, info.bootable))

			if (info.udf) add(fields, t("previewBinaryUdf"), yesNo(t, true))

			return {
				subtitle: t("previewBinaryKindDetail", { kind: t("previewBinaryIso"), detail: info.udf ? "UDF" : "ISO 9660" }),
				sections: [{ fields }]
			}
		}
	}
}
