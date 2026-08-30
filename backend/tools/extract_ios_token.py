#!/usr/bin/env python3
"""
MobilON+ backend JWT kiolvasása egy iOS helyi (Finder) backupból — JAILBREAK NÉLKÜL.

Az iOS backup tartalmazza az app NSUserDefaults-át
(Library/Preferences/com.hclinear.metaccazeMiskolc.plist), amiben a
`flutter.cached_backend_jwt` kulcs ül. (Az Androiddal ellentétben iOS-en a
helyi backup kiadja az app-preferenciákat.)

HASZNÁLAT
  1) Finder → iPhone → "Back up all the data ... to this Mac" → Back Up Now.
     Lehetőleg TITKOSÍTATLAN backup (egyszerűbb). Előtte nyisd meg 1x az appot.
  2) python3 extract_ios_token.py
     python3 extract_ios_token.py --ingest http://<PI-IP>:8088    # + betölti a gateway-be
"""
import argparse
import glob
import json
import os
import plistlib
import sqlite3
import sys
import urllib.request

BUNDLE = "com.hclinear.metaccazeMiskolc"
BACKUP_ROOT = os.path.expanduser("~/Library/Application Support/MobileSync/Backup")


def find_latest_backup():
    dirs = [d for d in glob.glob(os.path.join(BACKUP_ROOT, "*")) if os.path.isdir(d)]
    dirs = [d for d in dirs if os.path.exists(os.path.join(d, "Manifest.db"))]
    if not dirs:
        sys.exit(f"[!] Nincs backup Manifest.db-vel itt: {BACKUP_ROOT}\n"
                 "    Csinálj egy helyi backupot Finderben (lehetőleg titkosítatlant).")
    return max(dirs, key=lambda d: os.path.getmtime(os.path.join(d, "Manifest.db")))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ingest", help="gateway URL, pl. http://192.168.0.50:8088")
    ap.add_argument("--backup", help="explicit backup könyvtár (különben a legfrissebb)")
    args = ap.parse_args()

    bdir = args.backup or find_latest_backup()
    print(f"[*] Backup: {bdir}")
    man = os.path.join(bdir, "Manifest.db")

    try:
        con = sqlite3.connect(f"file:{man}?mode=ro", uri=True)
        cur = con.cursor()
        cur.execute(
            "SELECT fileID, relativePath FROM Files WHERE domain = ? AND relativePath LIKE ?",
            (f"AppDomain-{BUNDLE}", "%Preferences/%.plist"),
        )
        rows = cur.fetchall()
    except sqlite3.DatabaseError:
        sys.exit("[!] A Manifest.db nem olvasható → valószínűleg TITKOSÍTOTT backup.\n"
                 "    Megoldás: csinálj TITKOSÍTATLAN backupot, VAGY:\n"
                 "      pip install iOSbackup   és a jelszóval fejtsd vissza.")

    if not rows:
        cur.execute("SELECT relativePath FROM Files WHERE domain = ?", (f"AppDomain-{BUNDLE}",))
        allr = cur.fetchall()
        if not allr:
            sys.exit(f"[!] Az app ({BUNDLE}) nincs a backupban. Telepítve van? Készült friss backup?")
        print(f"[!] Nincs Preferences plist, de {len(allr)} app-fájl van. Minta:")
        for (rp,) in allr[:25]:
            print("   ", rp)
        sys.exit(1)

    token = None
    for fileID, rp in rows:
        path = os.path.join(bdir, fileID[:2], fileID)
        if not os.path.exists(path):
            continue
        try:
            with open(path, "rb") as f:
                pl = plistlib.load(f)
        except Exception:
            continue
        for k, v in pl.items():
            if isinstance(v, str) and v.startswith("eyJ") and v.count(".") == 2:
                print(f"[+] JWT megvan: kulcs='{k}'  ({rp})")
                token = v
            if "installation" in k.lower():
                print(f"[i] installation-id jelölt: {k} = {v}")

    if not token:
        sys.exit("[!] Nem találtam eyJ...-tokent a preferenciákban.\n"
                 "    Nyisd meg egyszer az appot (hogy elmentse a tokent), majd új backup + újrafuttatás.")

    print("\n=== JWT ===\n" + token + "\n")

    if args.ingest:
        url = args.ingest.rstrip("/") + "/_ingest"
        req = urllib.request.Request(
            url, data=json.dumps({"jwt": token}).encode(),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            resp = urllib.request.urlopen(req, timeout=10).read().decode()
            print("[+] Gateway /_ingest válasz:", resp)
        except Exception as e:
            print("[!] Gateway betöltés hiba:", e)


if __name__ == "__main__":
    main()
