# asight Linux redirector build (spec 4.6 §Linux 机制).
# Pipeline: vmlinux.h (from kernel BTF) -> asight.bpf.o (clang -target bpf, CO-RE)
#           -> asight.skel.h (bpftool gen skeleton) -> asight-redirector (cc + libbpf).
# All four outputs are generated build artifacts and are .gitignore'd — never committed.

BPFTOOL  ?= $(shell command -v bpftool 2>/dev/null || echo /usr/sbin/bpftool)
CLANG    ?= clang
CC       ?= cc

ARCH     := $(shell uname -m | sed 's/x86_64/x86/;s/aarch64/arm64/;s/ppc64le/powerpc/;s/mips.*/mips/')
BPF_DIR  := bpf
RD_DIR   := redirector

VMLINUX  := $(BPF_DIR)/vmlinux.h
BPF_OBJ  := $(BPF_DIR)/asight.bpf.o
SKEL     := $(RD_DIR)/asight.skel.h
BIN      := asight-redirector

CFLAGS   ?= -O2 -g -Wall
BPF_CFLAGS := -O2 -g -target bpf -D__TARGET_ARCH_$(ARCH) -I$(BPF_DIR)
# Link libbpf statically (-l:libbpf.a forces the archive) so the capped helper has no runtime
# dependency on a matching shared libbpf (D36 §2); libelf/zlib stay dynamic (base system).
LDLIBS   := -l:libbpf.a -lelf -lz
# Build hash baked into the `ready` line: sha256 of the three sources, so a given binary is
# traceable to its exact code. Falls back to "unknown" where sha256sum is unavailable.
BUILD_HASH := $(shell (cat $(RD_DIR)/redirector.c $(BPF_DIR)/asight.bpf.c $(BPF_DIR)/asight.h 2>/dev/null | sha256sum 2>/dev/null | cut -c1-12) || echo unknown)
BUILD_HASH := $(if $(BUILD_HASH),$(BUILD_HASH),unknown)

.PHONY: all clean selftest
all: $(BIN)

$(VMLINUX):
	$(BPFTOOL) btf dump file /sys/kernel/btf/vmlinux format c > $@

$(BPF_OBJ): $(BPF_DIR)/asight.bpf.c $(BPF_DIR)/asight.h $(VMLINUX)
	$(CLANG) $(BPF_CFLAGS) -c $< -o $@

$(SKEL): $(BPF_OBJ)
	$(BPFTOOL) gen skeleton $< name asight > $@

$(BIN): $(RD_DIR)/redirector.c $(SKEL) $(BPF_DIR)/asight.h
	$(CC) $(CFLAGS) -DASIGHT_BUILD_HASH='"$(BUILD_HASH)"' -I$(RD_DIR) -I$(BPF_DIR) $< -o $@ $(LDLIBS)

# Quick smoke run: load + attach + status + detach + exit (needs root).
selftest: $(BIN)
	sudo ./$(BIN) --selftest

clean:
	rm -f $(VMLINUX) $(BPF_OBJ) $(SKEL) $(BIN)
