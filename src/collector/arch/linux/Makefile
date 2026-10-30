# trocar Linux redirector build (spec 4.6 §Linux 机制).
# Pipeline: vmlinux.h (from kernel BTF) -> trocar.bpf.o (clang -target bpf, CO-RE)
#           -> trocar.skel.h (bpftool gen skeleton) -> trocar-redirector (cc + libbpf).
# All four outputs are generated build artifacts and are .gitignore'd — never committed.

# The kernel's own type information, which vmlinux.h is generated from (a kernel built without BTF cannot run the helper).
BTF      ?= /sys/kernel/btf/vmlinux
# The bpftool: the first candidate that reads this kernel's BTF (a raw dump succeeds) among PATH's, /usr/sbin's and every linux-tools build,
# newest version first. Ubuntu's /usr/sbin/bpftool is a wrapper that refuses a kernel it has no linux-tools package for (cloud and container
# kernels) while a linux-tools build of another version may read it; an old build may not read a newer kernel's BTF, which the dump shows.
# BPFTOOL=<path> on the command line or in the environment wins.
BPFTOOL_TRY ?= $(shell command -v bpftool 2>/dev/null) /usr/sbin/bpftool $(shell ls -d /usr/lib/linux-tools/*/bpftool 2>/dev/null | sort -rV)
BPFTOOL  ?= $(shell for b in $(BPFTOOL_TRY); do "$$b" btf dump file $(BTF) format raw >/dev/null 2>&1 && { echo "$$b"; break; }; done)
CLANG    ?= clang
CC       ?= cc

ARCH     := $(shell uname -m | sed 's/x86_64/x86/;s/aarch64/arm64/;s/ppc64le/powerpc/;s/mips.*/mips/')
BPF_DIR  := bpf
RD_DIR   := redirector

VMLINUX  := $(BPF_DIR)/vmlinux.h
BPF_OBJ  := $(BPF_DIR)/trocar.bpf.o
SKEL     := $(RD_DIR)/trocar.skel.h
BIN      := trocar-redirector

CFLAGS   ?= -O2 -g -Wall
BPF_CFLAGS := -O2 -g -target bpf -D__TARGET_ARCH_$(ARCH) -I$(BPF_DIR)
# Link libbpf statically (-l:libbpf.a forces the archive) so the capped helper has no runtime
# dependency on a matching shared libbpf (D36 §2); libelf/zlib stay dynamic (base system).
LDLIBS   := -l:libbpf.a -lelf -lz
# Build hash baked into the `ready` line: sha256 of the three sources, so a given binary is
# traceable to its exact code. Falls back to "unknown" where sha256sum is unavailable.
BUILD_HASH := $(shell (cat $(RD_DIR)/redirector.c $(BPF_DIR)/trocar.bpf.c $(BPF_DIR)/trocar.h 2>/dev/null | sha256sum 2>/dev/null | cut -c1-12) || echo unknown)
BUILD_HASH := $(if $(BUILD_HASH),$(BUILD_HASH),unknown)

# a recipe that fails removes its half-written target (an empty vmlinux.h would look up to date to the next make)
.DELETE_ON_ERROR:
.PHONY: all clean selftest
all: $(BIN)

$(VMLINUX):
	@test -r $(BTF) || { echo 'this kernel has no BTF ($(BTF)): the helper needs a kernel built with it' >&2; exit 1; }
	@test -n "$(BPFTOOL)" || { echo 'no bpftool here reads this kernel'"'"'s BTF: install bpftool or linux-tools (a recent version), or set BPFTOOL=<path>' >&2; exit 1; }
	$(BPFTOOL) btf dump file $(BTF) format c > $@

$(BPF_OBJ): $(BPF_DIR)/trocar.bpf.c $(BPF_DIR)/trocar.h $(VMLINUX)
	$(CLANG) $(BPF_CFLAGS) -c $< -o $@

$(SKEL): $(BPF_OBJ)
	$(BPFTOOL) gen skeleton $< name trocar > $@

$(BIN): $(RD_DIR)/redirector.c $(SKEL) $(BPF_DIR)/trocar.h
	$(CC) $(CFLAGS) -DTROCAR_BUILD_HASH='"$(BUILD_HASH)"' -I$(RD_DIR) -I$(BPF_DIR) $< -o $@ $(LDLIBS)

# Quick smoke run: load + attach + status + detach + exit (needs root).
selftest: $(BIN)
	sudo ./$(BIN) --selftest

clean:
	rm -f $(VMLINUX) $(BPF_OBJ) $(SKEL) $(BIN)
