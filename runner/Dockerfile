# The runner: the container a code session's workspace lives in. Arno's
# binary is built on the host (an Arch system) and copied in, so the image is
# Arch too, with the same C library and the shared libraries it links. The
# rest is what the model's shell is likely to need to build and test a
# project: a C toolchain, Node, Python and git (Go and Rust left out: they
# would double the image, on a 4 GB disk).
# Built and pushed by `npx wrangler deploy`; runner/prepare.cn copies arno in.
FROM archlinux:base
RUN pacman -Syu --noconfirm --needed \
      base-devel git openssh ca-certificates curl jq less tree \
      openssl zlib brotli zstd util-linux \
      nodejs npm python python-pip \
      ripgrep fd w3m \
    && pacman -Scc --noconfirm \
    && mkdir -p /workspace
COPY arno /usr/local/bin/arno
ENV LANG=C.UTF-8
WORKDIR /workspace
CMD ["sleep", "infinity"]
