#!/usr/bin/env bash
# Deploys one commit of Class Connect on the home server (#19, ADR 0003).
#
#   scripts/deploy.sh <sha>               build, back up, switch, restart, verify; roll back on failure
#   scripts/deploy.sh --restore <backup>  stop the app, put a backup in place of the database, start it
#
# Deploy steps:
#   1. clone <sha> into $CC_ROOT/releases/<sha> (built under a temporary name first);
#   2. npm ci, npm run check, npm run build there;
#   3. pre-deploy backup of the database (dist/server/backup.js);
#   4. repoint $CC_ROOT/current and restart the service;
#   5. poll the health URL until it reports <sha>; otherwise repoint to the previous release,
#      restart and fail. The database is never restored automatically.
# A failure in steps 1-3 never touches the running release. The last 5 releases are kept.
#
# The whole script is one function called on the last line, so `ssh wsl bash -s -- <sha> < deploy.sh`
# (npm run deploy) reads all of it before anything runs.
#
# Every path and command can be overridden for tests:
#   CC_ROOT            /srv/class-connect
#   CC_REPO_URL        https://github.com/ofeq-dev/class-connect.git
#   CC_DB              /var/lib/class-connect/app.db
#   CC_BACKUP_DIR      /mnt/d/class-connect-backups
#   CC_SERVICE         class-connect.service
#   CC_SYSTEMCTL       "sudo -n systemctl"   (called as: $CC_SYSTEMCTL restart|stop|start $CC_SERVICE)
#   CC_HEALTH_URL      https://cc.ofeq.dev/healthz
#   CC_HEALTH_TIMEOUT  30   seconds to wait for the new SHA
#   CC_HEALTH_INTERVAL 2    seconds between polls
#   CC_KEEP_RELEASES   5
#   CC_NPM             npm
#   CC_NODE            node

main() {
  set -euo pipefail

  local root="${CC_ROOT:-/srv/class-connect}"
  local repo_url="${CC_REPO_URL:-https://github.com/ofeq-dev/class-connect.git}"
  local db="${CC_DB:-/var/lib/class-connect/app.db}"
  local backup_dir="${CC_BACKUP_DIR:-/mnt/d/class-connect-backups}"
  local service="${CC_SERVICE:-class-connect.service}"
  local systemctl="${CC_SYSTEMCTL:-sudo -n systemctl}"
  local health_url="${CC_HEALTH_URL:-https://cc.ofeq.dev/healthz}"
  local health_timeout="${CC_HEALTH_TIMEOUT:-30}"
  local health_interval="${CC_HEALTH_INTERVAL:-2}"
  local keep="${CC_KEEP_RELEASES:-5}"
  local npm="${CC_NPM:-npm}"
  local node="${CC_NODE:-node}"

  log() { echo "[deploy] $*"; }
  die() { echo "[deploy] FAILED: $*" >&2; exit 1; }
  service_ctl() { $systemctl "$1" "$service" </dev/null; }

  usage() {
    echo "usage: deploy.sh <sha> | deploy.sh --restore <backup-file>" >&2
    exit 2
  }

  restore() {
    local backup="$1"
    [[ -f "$backup" ]] || die "no backup file at $backup"
    local aside
    aside="$db.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
    log "stopping $service"
    service_ctl stop
    if [[ -f "$db" ]]; then
      log "moving the current database aside to $aside"
      mv "$db" "$aside"
      local suffix
      for suffix in -wal -shm; do
        if [[ -f "$db$suffix" ]]; then mv "$db$suffix" "$aside$suffix"; fi
      done
    fi
    mkdir -p "$(dirname "$db")"
    cp "$backup" "$db.restoring"
    mv "$db.restoring" "$db"
    log "restored $backup; starting $service"
    service_ctl start
  }

  # Succeeds when the health endpoint answers with `"sha":"<sha>"`.
  health_reports() {
    local sha="$1" body
    body="$(curl -fsS --max-time 5 "$health_url" 2>/dev/null </dev/null)" || return 1
    [[ "$body" == *"\"sha\":\"$sha\""* ]]
  }

  wait_for_health() {
    local sha="$1" deadline
    deadline=$(( $(date +%s) + health_timeout ))
    while :; do
      if health_reports "$sha"; then return 0; fi
      (( $(date +%s) >= deadline )) && return 1
      sleep "$health_interval"
    done
  }

  prune_releases() {
    local current_target="$1" previous_target="$2" count=0 dir
    # Newest first by modification time (each release is touched when it goes live).
    while IFS= read -r dir; do
      [[ -z "$dir" ]] && continue
      count=$((count + 1))
      local path="$root/releases/$dir"
      if (( count > keep )) && [[ "$path" != "$current_target" && "$path" != "$previous_target" ]]; then
        log "removing old release $dir"
        rm -rf "$path"
      fi
    done < <(ls -1t "$root/releases")
  }

  deploy() {
    local sha="$1"
    [[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || die "not a commit SHA: $sha"

    mkdir -p "$root/releases"
    local release="$root/releases/$sha"
    local previous=""
    [[ -L "$root/current" ]] && previous="$(readlink "$root/current")"

    if [[ -d "$release" ]]; then
      log "release $sha already built; reusing it"
    else
      local building="$root/releases/.building-$sha-$$"
      # Anything that fails before the switch leaves only this directory behind, and we remove it.
      trap 'rm -rf "$building"' EXIT
      log "cloning $sha"
      git clone --quiet --no-checkout "$repo_url" "$building" </dev/null
      git -C "$building" -c advice.detachedHead=false checkout --quiet --detach "$sha" </dev/null \
        || die "commit $sha not found in $repo_url"
      local full_sha
      full_sha="$(git -C "$building" rev-parse HEAD)"
      [[ "$full_sha" == "$sha"* ]] || die "checked out $full_sha, expected $sha"
      sha="$full_sha"
      release="$root/releases/$sha"

      log "npm ci"
      (cd "$building" && $npm ci </dev/null) || die "npm ci failed; the running release is untouched"
      log "npm run check"
      (cd "$building" && $npm run check </dev/null) || die "npm run check failed; the running release is untouched"
      log "npm run build"
      (cd "$building" && $npm run build </dev/null) || die "npm run build failed; the running release is untouched"

      rm -rf "$release"
      mv "$building" "$release"
      trap - EXIT
    fi

    log "pre-deploy backup"
    (cd "$release" && DATABASE_PATH="$db" BACKUP_DIR="$backup_dir" \
      $node dist/server/backup.js --kind pre-deploy --label "${sha:0:12}" </dev/null) \
      || die "pre-deploy backup failed; the running release is untouched"

    log "switching current to $sha"
    touch "$release"
    ln -sfn "$release" "$root/current.next"
    mv -T "$root/current.next" "$root/current"
    service_ctl restart || log "restart command failed; checking health anyway"

    log "waiting up to ${health_timeout}s for $health_url to report $sha"
    if wait_for_health "$sha"; then
      log "live: $sha"
      prune_releases "$release" "$previous"
      return 0
    fi

    if [[ -n "$previous" && "$previous" != "$release" ]]; then
      log "health check did not report $sha; rolling back to $(basename "$previous")"
      ln -sfn "$previous" "$root/current.next"
      mv -T "$root/current.next" "$root/current"
      service_ctl restart || true
      die "$sha did not come up; rolled back to $(basename "$previous")"
    fi
    die "$sha did not come up and there is no previous release to roll back to"
  }

  case "${1:-}" in
    --restore) [[ $# -eq 2 ]] || usage; restore "$2" ;;
    ""|-*) usage ;;
    *) [[ $# -eq 1 ]] || usage; deploy "$1" ;;
  esac
}

main "$@"
