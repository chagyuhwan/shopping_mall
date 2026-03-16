#!/bin/bash
# KCSHOP DB 백업 스크립트
# 사용: ./scripts/backup-db.sh
# cron 예: 0 2 * * * /path/to/kcshop/scripts/backup-db.sh

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${DIR}/backups"
DATA_DIR="${DIR}/data"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"

if [ -f "${DATA_DIR}/users.db" ]; then
  cp "${DATA_DIR}/users.db" "${BACKUP_DIR}/users_${DATE}.db"
  echo "백업 완료: users_${DATE}.db"
fi

# 7일 이상 된 백업 삭제 (선택)
find "$BACKUP_DIR" -name "users_*.db" -mtime +7 -delete 2>/dev/null
