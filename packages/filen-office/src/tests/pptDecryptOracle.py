# msoffcrypto-tool oracle for encrypted PowerPoint 97-2003 files: decrypts the PowerPoint Document stream of <file>
# with <password> into <out>, as msoffcrypto-tool's Ppt97File decrypts it (its persist objects; it also clears the
# encryption session). The stream is captured where msoffcrypto would write it into the compound file, so a file whose
# Current User stream it cannot rewrite still yields the stream. Run under a Python with msoffcrypto-tool installed
# (FILEN_OFFICE_MSOFFCRYPTO), always with -I:
#   pptDecryptOracle.py <file> <password> <out>
# Prints one JSON line: {"ok": true} or {"ok": false, "error": ...}. The password is never printed.
import io
import json
import sys

import olefile
from msoffcrypto.format.ppt97 import Ppt97File


class Captured(Exception):
    pass


def main():
    path, password, out = sys.argv[1], sys.argv[2], sys.argv[3]
    captured = {}

    def capture(self, name, data):
        if name == "PowerPoint Document":
            captured["stream"] = bytes(data)
            raise Captured()

    olefile.OleFileIO.write_stream = capture
    with open(path, "rb") as handle:
        office = Ppt97File(handle)
        try:
            office.load_key(password=password)
        except Exception as error:
            print(json.dumps({"ok": False, "error": type(error).__name__}))
            return
        try:
            office.decrypt(io.BytesIO())
        except Captured:
            pass
    with open(out, "wb") as target:
        target.write(captured["stream"])
    print(json.dumps({"ok": True}))


main()
