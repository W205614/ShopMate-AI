#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ $# -gt 2 || ( $# -eq 2 && "$2" != --resume ) ]]; then
  printf '%s\n' 'Usage: production-release.sh [environment-file] [--resume]' >&2
  exit 1
fi
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
task_env="$(realpath -- "${1:-$task_root/.env.production}")"
export PRODUCTION_ENV_FILE="$task_env"
# Parse dotenv with Node, never source it as shell code.
read_setting() {
  node --input-type=module -e 'import {readFileSync} from "node:fs"; import {parseEnv} from "node:util"; process.stdout.write(parseEnv(readFileSync(process.argv[1],"utf8"))[process.argv[2]] ?? "")' "$task_env" "$1"
}
node "$task_root/scripts/production-preflight.mjs" "$task_env" --skip-docker
# Match preflight's dotenv values instead of conflicting host interpolation values.
for task_setting in API_IMAGE WEB_IMAGE CADDY_IMAGE VCS_REF PUBLIC_URL DOMAIN ACME_EMAIL SECRETS_PATH PRODUCTION_STATE_PATH BACKUP_PATH ASSET_PATH PROXY_SUBNET PROXY_DYNAMIC_RANGE CADDY_IP PROMETHEUS_IMAGE ALERTMANAGER_IMAGE ALERTMANAGER_CONFIG_PATH; do
  export "$task_setting=$(read_setting "$task_setting")"
done
task_project="$(read_setting COMPOSE_PROJECT_NAME)"
task_state="$(read_setting PRODUCTION_STATE_PATH)"
task_public="$(read_setting PUBLIC_URL)"
task_revision="$(read_setting VCS_REF)"
case "$task_state" in /*) ;; *) printf '%s\n' 'PRODUCTION_STATE_PATH must be absolute' >&2; exit 1 ;; esac
if [[ "$task_state" == / ]]; then exit 1; fi
task_compose=(docker compose --env-file "$task_env" -p "$task_project" -f "$task_root/deploy/compose.production.yaml")
mkdir -p -- "$task_state/maintenance" "$task_state/releases"
task_stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
task_receipt="$task_state/releases/$task_stamp-$task_revision.txt"
task_failed=1
finish_release() {
  if [[ "$task_failed" == 1 ]]; then
    if [[ -f "$task_state/maintenance/active" ]]; then
      printf '%s\n' 'Release failed. Maintenance remains active. Inspect logs; restore the verified pre-upgrade snapshot if the old binary cannot read the migrated database.' >&2
    else
      printf '%s\n' 'Release preparation failed before maintenance; running containers were not stopped.' >&2
    fi
    printf '%s\n' 'failed' >> "$task_receipt"
  fi
}
trap finish_release EXIT
printf 'revision=%s\nstarted=%s\n' "$task_revision" "$task_stamp" > "$task_receipt"
if [[ "${2:-}" == --resume ]]; then
  if [[ ! -f "$task_state/maintenance/active" || "$(< "$task_state/maintenance/active")" != "$task_revision" ]]; then
    printf '%s\n' 'Resume requires an active maintenance marker for this VCS_REF.' >&2
    exit 1
  fi
else
  # Pull first so a failed download does not interrupt the running store.
  for task_image_setting in API_IMAGE WEB_IMAGE CADDY_IMAGE; do
    task_image="$(read_setting "$task_image_setting")"
    if ! docker image inspect "$task_image" > /dev/null 2>&1; then
      docker pull "$task_image"
    fi
  done
  node "$task_root/scripts/production-preflight.mjs" "$task_env"
  printf '%s\n' "$task_revision" > "$task_state/maintenance/active"
  task_api_id="$("${task_compose[@]}" ps -a -q api)"
  # Retained data also needs a snapshot when the old container was removed.
  task_database="$("${task_compose[@]}" run --rm --no-deps -T api node --input-type=module -e 'import {existsSync} from "node:fs"; process.stdout.write(existsSync("/app/data/shopmate.sqlite") ? "existing" : "new")')"
  if [[ "$task_database" == existing ]]; then
    task_backup="/app/backups/shopmate-preupgrade-$task_stamp.sqlite"
    # Use the new image's CLI: an older running image may not include asset-aware backup commands.
    "${task_compose[@]}" run --rm --no-deps -T api node --import tsx src/production/remote-backup.ts backup-local /app/data/shopmate.sqlite "$task_backup" preupgrade
    "${task_compose[@]}" run --rm --no-deps -T api node --import tsx src/maintenance.ts inspect "$task_backup"
    printf 'backup=%s\n' "$task_backup" >> "$task_receipt"
  elif [[ "$task_database" != new ]]; then
    printf '%s\n' 'Could not determine whether the production database already exists.' >&2
    exit 1
  fi
  if [[ -n "$task_api_id" ]]; then
    # SIGTERM uses the API's drain-and-shutdown path before starting the new image.
    "${task_compose[@]}" stop -t 25 api
  fi
  "${task_compose[@]}" up -d --no-build --wait --wait-timeout 180
fi
node "$task_root/scripts/production-preflight.mjs" "$task_env" --runtime
"${task_compose[@]}" exec -T api node -e 'fetch("http://127.0.0.1:3001/api/health").then(async r=>{if(!r.ok||(await r.json()).status!=="ok")process.exit(1)}).catch(()=>process.exit(1))'
if [[ -f "$task_state/maintenance/active" ]]; then
  mv -- "$task_state/maintenance/active" "$task_state/releases/$task_stamp-maintenance-ended"
fi
if ! curl --fail --silent --show-error --max-time 15 "$task_public/api/health" | node -e 'let body="";process.stdin.on("data",chunk=>body+=chunk).on("end",()=>{try{if(JSON.parse(body).status!=="ok")process.exitCode=1}catch{process.exitCode=1}})'; then
  printf '%s\n' "$task_revision" > "$task_state/maintenance/active"
  exit 1
fi
printf '%s\n' 'healthy' >> "$task_receipt"
task_failed=0
printf 'Release healthy: %s\n' "$task_revision"
