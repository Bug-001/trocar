#!/bin/sh
# build-darwin-native.sh — the ONE deliberate rebuild of the macOS native pieces (plan decision #10, RFC 4.9 §3 ⑮).
# Builds src/collector/arch/darwin/native/{asight-sign-helper,procenv} as universal (arm64 + x86_64, macOS 13+) binaries and
# rewrites native/pins.json with their sha256. Commit the binaries and pins.json together: `npm pack` copies them and nothing
# rebuilds at pack time (a rebuild changes the helper's code hash, and the login keychain then asks for the password again, R3-M2).
# Needs the Command Line Tools (swiftc, clang, lipo). Never runs what it builds.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
dir="$here/src/collector/arch/darwin/native"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for arch in arm64 x86_64; do
  mkdir "$tmp/$arch" # the output's name is the ad-hoc signature's identifier: keep it the installed name
  swiftc -O -target "$arch-apple-macos13" -o "$tmp/$arch/asight-sign-helper" "$dir/sign-helper.swift"
done
lipo -create -output "$dir/asight-sign-helper" "$tmp/arm64/asight-sign-helper" "$tmp/x86_64/asight-sign-helper"
clang -arch arm64 -arch x86_64 -mmacosx-version-min=13 -O2 -Wall -o "$dir/procenv" "$dir/procenv.c"
chmod 755 "$dir/asight-sign-helper" "$dir/procenv"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
printf '{\n  "asight-sign-helper": "%s",\n  "procenv": "%s"\n}\n' "$(sha "$dir/asight-sign-helper")" "$(sha "$dir/procenv")" > "$dir/pins.json"
lipo -info "$dir/asight-sign-helper" "$dir/procenv"
cat "$dir/pins.json"
