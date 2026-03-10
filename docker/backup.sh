#!/bin/sh
# PostgreSQL automated backup script
# Runs via cron inside the backup container

BACKUP_DIR="/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/postautomation_${TIMESTAMP}.sql.gz"

echo "[$(date)] Starting database backup..."

# Create backup
pg_dump --format=custom --compress=9 | gzip > "$BACKUP_FILE"

if [ $? -eq 0 ]; then
    echo "[$(date)] Backup completed: $BACKUP_FILE ($(du -sh "$BACKUP_FILE" | cut -f1))"
else
    echo "[$(date)] ERROR: Backup failed!"
    exit 1
fi

# Clean up old backups
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-30}
find "$BACKUP_DIR" -name "postautomation_*.sql.gz" -mtime +${RETENTION_DAYS} -delete
echo "[$(date)] Cleaned backups older than ${RETENTION_DAYS} days"

# Add to crontab (runs daily at 2 AM)
echo "0 2 * * * /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1" | crontab -
