# The runner: the container a code session's workspace lives in. Arno comes
# from its pinned GitHub release, checked against its sha256; the release is
# built on Arch, so the image is Arch too, with the same C library and the
# shared libraries it links. The rest is what the model's shell is likely to
# need to build and test a project: a C toolchain, Node, Python and git (Go
# and Rust left out: they would double the image, on a 4 GB disk).
# wrangler builds this file at deploy (wrangler.jsonc); OPERATIONS.md says
# how to move to a newer arno.
FROM archlinux:base
RUN pacman -Syu --noconfirm --needed \
      base-devel git openssh ca-certificates curl jq less tree \
      openssl zlib brotli zstd util-linux \
      nodejs npm python python-pip \
      ripgrep fd w3m \
    && pacman -Scc --noconfirm \
    && mkdir -p /workspace
# The arno release, and the sha256 its release lists.
ARG ARNO=v0.11.0
ARG ARNO_SHA256=564aceb32e547498aca658ce2ecce66168a7e05d3518047c4491720811eb8506
RUN curl -fsSL -o /usr/local/bin/arno \
      https://github.com/ldiaz94/arno/releases/download/$ARNO/arno-linux-x86_64 \
    && echo "$ARNO_SHA256  /usr/local/bin/arno" | sha256sum -c - \
    && chmod +x /usr/local/bin/arno
ENV LANG=C.UTF-8
WORKDIR /workspace
CMD ["sleep", "infinity"]
