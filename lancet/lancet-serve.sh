#!/bin/sh
# llamastash generic wrapper for LANCET Nano in Docker (image pi-automode-lancet:0.4.3).
# $1 = port. The container listens on 8080 and is published on 127.0.0.1 only.
port="$1"
name="llamastash-lancet-$port"          # per port, so two launches don't collide
docker rm -f "$name" >/dev/null 2>&1    # leftover from a crashed daemon
# A stopped --rm container keeps its name until Docker finishes removing it.
for _ in $(seq 60); do docker container inspect "$name" >/dev/null 2>&1 || break; sleep 1; done
docker run -d --rm --name "$name" -p "127.0.0.1:$port:8080" \
  --read-only --cap-drop ALL --security-opt no-new-privileges --memory 1g \
  pi-automode-lancet:0.4.3 >/dev/null || exit 1
# One clean stop: SIGTERM from llamastash becomes `docker stop`.
trap 'docker stop -t 5 "$name" >/dev/null 2>&1' TERM INT
docker logs -f "$name" 2>&1 &
docker wait "$name" >/dev/null &
wait $!
