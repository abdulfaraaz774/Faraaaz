#!/bin/sh
# Daily backup of the database and photos. Add to cron:
#   15 2 * * * /opt/sbk-facility-ops/deploy/backup.sh
# Docker users: run it with DATA_DIR pointing at the volume, e.g.
#   DATA_DIR=$(docker volume inspect sbk-facility-ops_sbk-data -f '{{.Mountpoint}}') ./deploy/backup.sh
set -eu
DATA_DIR=${DATA_DIR:-/var/lib/sbk-ops}
OUT=${BACKUP_DIR:-/var/backups/sbk-ops}
mkdir -p "$OUT"
STAMP=$(date +%Y%m%d-%H%M)
sqlite3 "$DATA_DIR/sbk-ops.db" ".backup '$OUT/sbk-ops-$STAMP.db'"
tar -czf "$OUT/uploads-$STAMP.tar.gz" -C "$DATA_DIR" uploads
find "$OUT" -type f -mtime +30 -delete
echo "Backup written to $OUT"
