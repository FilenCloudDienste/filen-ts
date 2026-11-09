// CRC-32 (ISO-HDLC) for PNG chunks (PNG 3rd ed. §5.5), the same table-driven routine the office zip writer uses:
// one copy of the tables in the bundle. Continues a running CRC: crc32(b, crc32(a)) === crc32(a + b).
export { crc32 } from "@filen/office/core/opc"
