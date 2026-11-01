#!/bin/sh
# trocar installer for macOS and Linux (spec 4.5 section A, D74):  curl -fsSL <url>/install.sh | sh
# It places the npm tarball of trocar and a pinned official Node under ~/.trocar/app, checks both against their hashes before
# anything runs, then hands over to `trocar install` (first time) or `trocar update`. Machine state is never touched here.
# Everything is a function; the last line calls main inside braces, so a truncated download parses to an error and runs nothing.
# Options: --check (print the latest version), --stage (download, check and place a version without switching to it).
set -u
LC_ALL=C
export LC_ALL

# >>> SOURCES (the data lines equal install.ps1's, line for line: release check `installer`)
SOURCES='
package trocar-cli
registry https://registry.npmjs.org
registry https://registry.npmmirror.com
node https://nodejs.org/dist
node https://npmmirror.com/mirrors/node
'
# <<< SOURCES

say() { printf '%s\n' "$*" >&2; }
die() { say "$*"; exit 1; }
refuse() { say "$*"; exit 2; }
result() { printf 'trocar-installer: %s\n' "$*"; }
has() { command -v "$1" >/dev/null 2>&1; }
list() { printf '%s\n' "$SOURCES" | awk -v k="$1" '$1 == k { print $2 }'; }
host() { h=${1#*://}; printf '%s' "${h%%/*}"; }

# https only; plain http only to this machine (tests, a local mirror)
url_ok() {
  case $1 in
    https://*) return 0 ;;
    http://127.0.0.1[:/]* | http://localhost[:/]* | http://\[::1\][:/]*) return 0 ;;
  esac
  return 1
}
proto() { case $1 in https://*) printf '%s' '--proto =https --proto-redir =https --tlsv1.2' ;; *) printf '%s' '--proto =http' ;; esac; }

home_resolve() {
  if [ -z "${HOME:-}" ]; then
    u=$(id -un 2>/dev/null) || u=
    if has getent; then HOME=$(getent passwd "$u" | cut -d: -f6)
    elif has dscl; then HOME=$(dscl . -read "/Users/$u" NFSHomeDirectory 2>/dev/null | awk '{ print $2 }')
    fi
    export HOME
  fi
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || refuse "Cannot find your home directory: set HOME and run this again."
  [ ! -e "$HOME/.trocar" ] || [ -O "$HOME/.trocar" ] || refuse "$HOME/.trocar belongs to another user: run this as the user who owns it."
}

target_detect() {
  os=$(uname -s 2>/dev/null) || os=unknown
  arch=$(uname -m 2>/dev/null) || arch=unknown
  case $os in
    Darwin)
      plat=darwin ext=tar.xz
      # a shell under Rosetta reports x86_64 on an Apple silicon Mac
      if [ "$arch" = x86_64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then arch=arm64; fi ;;
    Linux)
      [ "$(uname -o 2>/dev/null)" != Android ] || refuse "Android and Termux are not supported: trocar needs a glibc Linux with systemd --user."
      for f in /lib/ld-musl-*; do
        [ ! -e "$f" ] || refuse "musl Linux (such as Alpine) is not supported: trocar needs a glibc Linux with systemd --user."
      done
      plat=linux ext=tar.gz
      if has xz; then ext=tar.xz; fi
      if grep -qi microsoft /proc/version 2>/dev/null; then say "Note: inside WSL, trocar sees only the agents that run inside WSL."; fi ;;
    MINGW* | MSYS* | CYGWIN*) refuse "On Windows, run install.ps1 in PowerShell instead (see the README)." ;;
    *) refuse "This system ($os) is not supported: trocar runs on macOS, Linux and Windows." ;;
  esac
  case $arch in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) refuse "This CPU ($arch) is not supported: trocar needs x64 or arm64." ;;
  esac
  [ "$(getconf LONG_BIT 2>/dev/null)" = 64 ] || refuse "A 32-bit system is not supported: trocar needs a 64-bit one."
  target=$plat-$arch
}

tools_check() {
  dl=
  if has curl; then case $(command -v curl) in /snap/*) ;; *) dl=curl ;; esac; fi
  if [ -z "$dl" ] && has wget; then dl=wget; fi
  [ -n "$dl" ] || refuse "Neither curl nor wget is installed: install one, then run this again."
  has sha256sum || has shasum || has openssl || refuse "No checksum tool (sha256sum, shasum or openssl) is installed: install one, then run this again."
  for t in tar awk; do has "$t" || refuse "$t is not installed: install it, then run this again."; done
}

hash_of() { # <256|512> <file> -> lowercase hex
  if has "sha$1sum"; then "sha$1sum" "$2" | awk '{ print $1 }'
  elif has shasum; then shasum -a "$1" "$2" | awk '{ print $1 }'
  else openssl dgst "-sha$1" -r "$2" | awk '{ print $1 }'
  fi
}

b64hex() { # base64 (an npm integrity value) -> hex, with no tool beyond awk
  printf '%s\n' "$1" | awk 'BEGIN { a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; for (i = 0; i < 64; i++) m[substr(a, i + 1, 1)] = i; h = "0123456789abcdef" }
    { bits = 0; n = 0; out = ""
      for (i = 1; i <= length($0); i++) { c = substr($0, i, 1); if (c == "=") break; if (!(c in m)) exit 1
        bits = bits * 64 + m[c]; n += 6
        if (n >= 8) { n -= 8; b = int(bits / 2 ^ n); bits -= b * 2 ^ n; out = out substr(h, int(b / 16) + 1, 1) substr(h, b % 16 + 1, 1) } }
      print out }'
}

older() { # true when version $1 is older than $2 (major.minor.patch)
  awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, /[.+-]/); split(b, y, /[.+-]/)
    for (i = 1; i <= 3; i++) { if (x[i] + 0 < y[i] + 0) exit 0; if (x[i] + 0 > y[i] + 0) exit 1 } exit 1 }'
}

get() { # <url> -> body on stdout
  url_ok "$1" || return 1
  if [ "$dl" = curl ]; then curl -fsSL $(proto "$1") --connect-timeout 10 --max-time 30 --retry 2 "$1" </dev/null
  else wget -q -O - --timeout=30 --tries=2 "$1" </dev/null
  fi
}

fetch_to() { # <url> <part> <pass>: append to the part (resume); returns the tool's exit code
  if [ "$dl" = curl ]; then
    if [ "$3" = 1 ]; then floor='--speed-limit 51200 --speed-time 15'; else floor='--speed-limit 1024 --speed-time 30'; fi
    bar=-sS; if [ -t 2 ]; then bar=-#; fi
    curl -fL $bar $(proto "$1") -C - --connect-timeout 10 --retry 2 $floor -o "$2" "$1" </dev/null
  else
    if [ "$3" = 1 ]; then t=15; else t=30; fi
    wget -q -c --timeout="$t" --tries=2 -O "$2" "$1" </dev/null
  fi
}

net_fail=
download() { # <expected hex> <256|512> <out> <url>...: verified bytes at <out>, or return 1 with one reason line per source
  want=$1 algo=$2 out=$3
  shift 3
  part="$APP/.dl/$want.part"
  for pass in 1 2; do
    slow=
    for u in "$@"; do
      url_ok "$u" || { say "  $(host "$u"): not https, skipped."; continue; }
      tries=0
      while :; do
        if [ -f "$part" ] && [ "$(hash_of "$algo" "$part")" = "$want" ]; then mv -f "$part" "$out" || die "Cannot write $out."; return 0; fi
        fetch_to "$u" "$part" "$pass"
        rc=$?
        if [ -f "$part" ] && [ "$(hash_of "$algo" "$part")" = "$want" ]; then continue; fi
        case $rc in
          0 | 33) rm -f "$part"; tries=$((tries + 1)); [ "$tries" -lt 2 ] && continue
            say "  $(host "$u"): the bytes do not match the expected hash." ;;
          28) slow="$slow $u"; say "  $(host "$u"): too slow, trying the next source." ;;
          5 | 6 | 7 | 35 | 4) net_fail=1; say "  $(host "$u"): cannot connect (error $rc)." ;;
          *) say "  $(host "$u"): download failed (error $rc)." ;;
        esac
        break
      done
    done
    [ -n "$slow" ] || break
    set -- $slow
  done
  return 1
}

# Only when nothing could connect and no proxy variable is set: read the macOS system proxy once (read-only, D43 D49).
sys_proxy() {
  [ -n "$net_fail" ] && [ -z "${https_proxy:-}${HTTPS_PROXY:-}${all_proxy:-}${ALL_PROXY:-}" ] && has scutil || return 1
  p=$(scutil --proxy 2>/dev/null </dev/null | awk '$1 == "HTTPSEnable" { he = $3 } $1 == "HTTPSProxy" { hp = $3 } $1 == "HTTPSPort" { hpo = $3 }
    $1 == "SOCKSEnable" { se = $3 } $1 == "SOCKSProxy" { sp = $3 } $1 == "SOCKSPort" { spo = $3 }
    END { if (he == 1 && hp != "") print "http://" hp ":" hpo; else if (se == 1 && sp != "") print "socks5h://" sp ":" spo }')
  [ -n "$p" ] || return 1
  https_proxy=$p
  export https_proxy
  net_fail=
  say "Trying again through the system proxy $p (a PAC file is not run)."
}

meta_fetch() { # sets v, integ_hex, tball, regs
  regs=${TROCAR_REGISTRY:-$(list registry)}
  first=
  for r in $regs; do
    r=${r%/}
    [ -n "$first" ] || first=$r
    if ! m=$(get "$r/$pkg/latest"); then net_fail=1; say "  $(host "$r"): the package record could not be read."; continue; fi
    m=$(printf '%s' "$m" | tr ',{}' '\n\n\n')
    tball=$(printf '%s\n' "$m" | sed -n 's/^ *"tarball" *: *"\([^"]*\)".*/\1/p' | head -n 1)
    integ=$(printf '%s\n' "$m" | sed -n 's/^ *"integrity" *: *"sha512-\([A-Za-z0-9+\/=]*\)".*/\1/p' | head -n 1)
    v=$(printf '%s' "$tball" | sed -n "s#^.*/$pkg-\\([0-9][0-9A-Za-z.+-]*\\)\\.tgz\$#\\1#p")
    integ_hex=$(b64hex "$integ")
    if [ -n "$v" ] && [ ${#integ_hex} = 128 ]; then
      if [ "$r" != "$first" ]; then say "Verified against $(host "$r")'s package record."; fi
      return 0
    fi
    say "  $(host "$r"): the package record has no usable tarball or sha512 integrity."
  done
  return 1
}

sweep() { # leftovers of runs whose process is gone
  for d in "$APP"/.staging-*; do
    [ -d "$d" ] || continue
    p=${d##*.staging-}
    case $p in '' | *[!0-9]*) continue ;; esac
    kill -0 "$p" 2>/dev/null || rm -rf "$d"
  done
}

handoff() { # <verb>
  bin="$HOME/.trocar/bin/trocar"
  other=$(command -v trocar 2>/dev/null) || other=
  if [ -n "$other" ] && [ "$other" != "$bin" ]; then
    say "Another trocar is on your PATH: $other. It is found before $bin until you remove it."
  fi
  if [ -t 1 ] && (: </dev/tty) 2>/dev/null; then exec "$bin" "$1" </dev/tty; fi
  say "Next: $bin $1"
}

main() {
  mode=install
  for a in "$@"; do
    case $a in
      --check) mode=check ;;
      --stage) mode=stage ;;
      -h | --help) say "Usage: install.sh [--check | --stage]"; return 0 ;;
      *) refuse "Unknown option: $a. Usage: install.sh [--check | --stage]" ;;
    esac
  done
  [ "$(id -u 2>/dev/null)" != 0 ] || refuse "trocar installs per user: run this as your own user, not with sudo."
  home_resolve
  target_detect
  tools_check
  pkg=$(list package)
  APP="$HOME/.trocar/app"
  meta_fetch || { sys_proxy && meta_fetch; } || die "Could not read the trocar package record from any registry. Nothing changed."
  if [ "$mode" = check ]; then result "latest $v"; return 0; fi

  cur_v= cur_n=
  if [ -f "$APP/current" ]; then read -r cur_v cur_n <"$APP/current" || :; fi
  if [ "$cur_v" = "$v" ] && [ -x "$APP/node/$cur_n/bin/node" ]; then
    if [ "$mode" = stage ]; then result "up-to-date $v"; else say "trocar $v is already installed: $HOME/.trocar/bin/trocar"; fi
    return 0
  fi
  if [ -n "$cur_v" ] && older "$v" "$cur_v"; then
    say "The package record ($v) is older than the installed trocar ($cur_v); a mirror has not caught up yet. Nothing changed."
    if [ "$mode" = stage ]; then result "up-to-date $cur_v"; fi
    return 0
  fi

  (umask 077 && mkdir -p "$HOME/.trocar") || die "Cannot create $HOME/.trocar."
  mkdir -p "$APP/.dl" "$APP/node" || die "Cannot create $APP."
  sweep
  STAGE="$APP/.staging-$$"
  trap 'rm -rf "$STAGE"' EXIT
  trap 'exit 1' INT TERM HUP
  mkdir "$STAGE" || die "Cannot create $STAGE."

  pkgdir="$APP/$v"
  if [ ! -f "$pkgdir/bin/trocar.mjs" ]; then
    [ ! -e "$pkgdir" ] || die "$pkgdir is incomplete: remove it, then run this again."
    set -- "$tball"
    for r in $regs; do u="${r%/}/$pkg/-/$pkg-$v.tgz"; [ "$u" = "$tball" ] || set -- "$@" "$u"; done
    say "Downloading trocar $v..."
    download "$integ_hex" 512 "$STAGE/pkg.tgz" "$@" || die "Could not download trocar $v from any source. Nothing changed."
    mkdir "$STAGE/pkg" && tar -xzf "$STAGE/pkg.tgz" -C "$STAGE/pkg" </dev/null && mv "$STAGE/pkg/package" "$STAGE/$v" \
      || die "The trocar $v package did not unpack. Nothing changed."
    pkgdir="$STAGE/$v"
  fi

  line=$(awk -v s="-$target.$ext" 'substr($2, 1, 6) == "node-v" && substr($2, length($2) - length(s) + 1) == s { print; exit }' "$pkgdir/install/node.sha256" 2>/dev/null)
  [ -n "$line" ] || die "trocar $v names no Node build for $target. Nothing changed."
  nhex=${line%% *}
  nfile=${line##* }
  nver=${nfile#node-v}
  nver=${nver%-"$target.$ext"}
  nid=$nver-$target
  ndir="$APP/node/$nid"
  if [ ! -x "$ndir/bin/node" ]; then
    set --
    for m in ${TROCAR_NODE_MIRROR:-$(list node)}; do set -- "$@" "${m%/}/v$nver/$nfile"; done
    say "Downloading Node $nver for $target..."
    download "$nhex" 256 "$STAGE/$nfile" "$@" || die "Could not download Node $nver from any source. Nothing changed."
    z=z
    if [ "$ext" = tar.xz ]; then z=J; fi
    mkdir -p "$STAGE/nx" "$STAGE/node/bin" && tar "-x${z}f" "$STAGE/$nfile" -C "$STAGE/nx" "node-v$nver-$target/bin/node" </dev/null \
      && mv "$STAGE/nx/node-v$nver-$target/bin/node" "$STAGE/node/bin/node" || die "The Node $nver archive did not unpack. Nothing changed."
    ndir="$STAGE/node"
  fi

  # the gates replace any OS-version table: a Node or a trocar that does not start here stops the install before it is placed
  got=$("$ndir/bin/node" --version </dev/null 2>"$STAGE/err") || got=
  [ "$got" = "v$nver" ] || die "This Node build does not run here: $(head -c 300 "$STAGE/err" 2>/dev/null)"
  got=$("$ndir/bin/node" "$pkgdir/bin/trocar.mjs" --version </dev/null 2>"$STAGE/err") || got=
  [ "$got" = "trocar $v" ] || die "trocar $v does not start on Node $nver: $got $(head -c 300 "$STAGE/err" 2>/dev/null)"

  if [ ! -x "$APP/node/$nid/bin/node" ]; then mv "$STAGE/node" "$APP/node/$nid" || die "Cannot place Node in $APP/node."; fi
  if [ ! -f "$APP/$v/bin/trocar.mjs" ]; then mv "$STAGE/$v" "$APP/$v" || die "Cannot place trocar in $APP."; fi
  if [ "$mode" = stage ]; then result "staged $v $APP/$v"; return 0; fi

  verb=install
  if [ -n "$cur_v" ]; then verb=update; fi
  "$APP/node/$nid/bin/node" "$APP/$v/bin/trocar.mjs" place "$APP/$v" </dev/null \
    || die "Could not switch to trocar $v (trocar place failed). The version that was active stays active."
  rm -rf "$STAGE"
  handoff "$verb"
}

{ main "$@" || exit 1; }
