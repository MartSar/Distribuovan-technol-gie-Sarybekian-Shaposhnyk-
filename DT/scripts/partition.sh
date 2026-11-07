#!/bin/sh
# Skutočné odpojenie uzla od siete "cluster".
#   ./scripts/partition.sh b disconnect
#   ./scripts/partition.sh b connect
set -e
NODE=$1; ACTION=$2; NET=gatesync_cluster
for svc in api-$NODE worker-$NODE; do
  if [ "$ACTION" = "disconnect" ]; then
    docker network disconnect $NET gatesync-$svc-1
  else
    docker network connect --alias $svc $NET gatesync-$svc-1
  fi
  echo "$ACTION gatesync-$svc-1 ($NET)"
done
