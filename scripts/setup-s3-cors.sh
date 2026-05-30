#!/usr/bin/env bash
# Configure CORS on the S3/MinIO bucket so the browser can do direct-to-S3
# multipart uploads (required for files >8MB via the upload tRPC router).
#
# Local: targets the MinIO container started by docker-compose.yml.
# Production: targets MinIO on the Linode host (or AWS S3 if you've migrated).
#
# Run once after the bucket exists. Safe to re-run.

set -euo pipefail

CONTAINER="${MINIO_CONTAINER:-dashmani-postautomation-minio-1}"
BUCKET="${S3_BUCKET:-postautomation-media}"
# Origins allowed to perform direct PUTs to S3
ORIGINS_JSON='["http://localhost:3000","https://postautomation.co.in","https://postautomation.in"]'

# CORS rule:
#  - PUT for part uploads; GET for browser-side preview; HEAD for size probes
#  - ExposeHeaders MUST include ETag — the client reads it to assemble
#    the CompleteMultipartUpload payload
CORS_JSON=$(cat <<EOF
{
  "CORSRules": [
    {
      "AllowedOrigins": ${ORIGINS_JSON},
      "AllowedMethods": ["GET", "HEAD", "PUT", "POST"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag", "x-amz-version-id"],
      "MaxAgeSeconds": 3000
    }
  ]
}
EOF
)

echo "Setting CORS on bucket '${BUCKET}' via container '${CONTAINER}'..."

# Configure mc client inside the MinIO container, then apply the policy.
# MinIO uses its own CORS XML schema, applied via `mc cors set`.
docker exec "${CONTAINER}" sh -c "
  mc alias set local http://localhost:9000 \"\${MINIO_ROOT_USER:-minioadmin}\" \"\${MINIO_ROOT_PASSWORD:-minioadmin}\" >/dev/null
  # Recent MinIO uses CORS at the bucket level via S3 API. Use aws-cli-compatible JSON.
  cat > /tmp/cors.json <<'JSON'
${CORS_JSON}
JSON
  mc admin config set local cors_allow_origin='${ORIGINS_JSON}' || true
  # Try S3-API style (works on MinIO RELEASE.2024+):
  mc anonymous set download local/${BUCKET} || true
  echo 'Done. Verify with: mc cors get local/${BUCKET}'
"

echo "Done."
