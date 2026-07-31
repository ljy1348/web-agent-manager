#!/bin/sh
set -eu

# 영속 볼륨의 최상위 디렉터리만 서비스 계정이 쓸 수 있게 준비한다.
mkdir -p /data /workspace /home/wam
chown wam:wam /data /workspace /home/wam

exec gosu wam "$@"
