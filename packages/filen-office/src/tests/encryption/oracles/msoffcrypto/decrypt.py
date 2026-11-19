# msoffcrypto-tool oracle for encrypted OOXML. Decrypts one CFB-wrapped package with a password and reports
# whether the plaintext is a zip and, optionally, whether it equals an expected plaintext. Run under a Python
# that has msoffcrypto-tool installed (FILEN_OFFICE_MSOFFCRYPTO), always with -I:
#   decrypt.py <file> <password> [expectedPlaintextZip]
# Prints one JSON line: {"ok", "startsPK", "plaintextSize", "integritySupported", "integrityVerified",
# "matchedPlaintext"?} or an error. integritySupported is false when this msoffcrypto-tool has no
# verify_integrity keyword, so a false integrityVerified then says nothing about the file.
import inspect
import io
import json
import sys

import msoffcrypto


def main():
    path, password = sys.argv[1], sys.argv[2]
    expected = sys.argv[3] if len(sys.argv) > 3 else None
    with open(path, "rb") as handle:
        office = msoffcrypto.OfficeFile(handle)
        try:
            office.load_key(password=password, verify_password=True)
        except Exception as error:
            print(json.dumps({"ok": False, "error": "%s: %s" % (type(error).__name__, error)}))
            return
        out = io.BytesIO()
        # Agile files carry a data-integrity HMAC; ask msoffcrypto to check it when this version can.
        integrity_supported = "verify_integrity" in inspect.signature(office.decrypt).parameters
        integrity_verified = False
        if integrity_supported:
            try:
                office.decrypt(out, verify_integrity=True)
                integrity_verified = True
            except Exception:
                out = io.BytesIO()
        if not integrity_verified:
            # Standard files have no integrity container, and a failed check still reports the plaintext.
            office.decrypt(out)
    data = out.getvalue()
    result = {
        "ok": True,
        "startsPK": data[:2] == b"PK",
        "plaintextSize": len(data),
        "integritySupported": integrity_supported,
        "integrityVerified": integrity_verified,
    }
    if expected is not None:
        with open(expected, "rb") as handle:
            result["matchedPlaintext"] = handle.read() == data
    print(json.dumps(result))


main()
