FROM ubuntu:24.04

# Pre-bake everything the verifier and terminal-driving agents need, so nothing
# is installed at run time (run-time installs are flaky and were the #1 cause of
# "no reward file" failures). The verifier is plain python3; tmux + asciinema are
# what tmux-driven agent harnesses (e.g. terminus) expect.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 tmux asciinema ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
