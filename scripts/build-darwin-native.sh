#!/bin/sh
# build-darwin-native.sh — the ONE deliberate rebuild of the macOS native pieces (plan decision #10, RFC 4.9 §3 ⑮).
# Builds src/collector/arch/darwin/native/{trocar-sign-helper,procenv,socktable} as universal (arm64 + x86_64, macOS 13+) binaries and
# rewrites native/pins.json with their sha256. Commit the binaries and pins.json together: `npm pack` copies them and nothing
# rebuilds at pack time (a rebuild changes the helper's code hash, and the login keychain then asks for the password again, R3-M2).
# Name the pieces to build to leave the others' bytes — and their hashes — alone: `build-darwin-native.sh procenv` rebuilds procenv
# and keeps the sign helper the keychain already trusts. No argument builds all three.
# Needs the Command Line Tools (swiftc, clang, lipo). Never runs what it builds.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
dir="$here/src/collector/arch/darwin/native"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
want=" ${*:-trocar-sign-helper procenv socktable} "
build() { case "$want" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

if build trocar-sign-helper; then
for arch in arm64 x86_64; do
  mkdir "$tmp/$arch" # the output's name is the ad-hoc signature's identifier: keep it the installed name
  swiftc -O -target "$arch-apple-macos13" -o "$tmp/$arch/trocar-sign-helper" "$dir/sign-helper.swift"
done
lipo -create -output "$dir/trocar-sign-helper" "$tmp/arm64/trocar-sign-helper" "$tmp/x86_64/trocar-sign-helper"
fi
if build procenv; then
clang -arch arm64 -arch x86_64 -mmacosx-version-min=13 -O2 -Wall -o "$dir/procenv" "$dir/procenv.c"
fi
if build socktable; then
clang -arch arm64 -arch x86_64 -mmacosx-version-min=13 -O2 -Wall -o "$dir/socktable" "$dir/socktable.c"
fi
chmod 755 "$dir/trocar-sign-helper" "$dir/procenv" "$dir/socktable"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
printf '{\n  "trocar-sign-helper": "%s",\n  "procenv": "%s",\n  "socktable": "%s"\n}\n' "$(sha "$dir/trocar-sign-helper")" "$(sha "$dir/procenv")" "$(sha "$dir/socktable")" > "$dir/pins.json"
lipo -info "$dir/trocar-sign-helper" "$dir/procenv" "$dir/socktable"
cat "$dir/pins.json"
