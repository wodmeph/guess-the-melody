#!/usr/bin/env bash
# Установщик Guess the Melody: Docker Compose на Debian/Ubuntu с systemd.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/wodmeph/guess-the-melody.git}"
REPO_REF="${REPO_REF:-main}"
INSTALL_DIR="${INSTALL_DIR:-}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
DOMAIN="${DOMAIN:-}"
ACME_EMAIL="${ACME_EMAIL:-}"
APP_HOST_PORT="${APP_HOST_PORT:-}"
AUDIO_DELIVERY_MODE="${AUDIO_DELIVERY_MODE:-}"
YANDEX_MUSIC_TOKEN="${YANDEX_MUSIC_TOKEN:-}"
ALLOW_DOMAIN_CHANGE="${ALLOW_DOMAIN_CHANGE:-0}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
CADDY_SITES_DIR="${CADDY_SITES_DIR:-/etc/caddy/conf.d}"
CADDY_SITES_DIR="${CADDY_SITES_DIR%/}"

BASE_INSTALL_DIR="/opt/guess-the-melody"
DEFAULT_APP_PORT=3001
DEFAULT_AUDIO_MODE="direct"
HEALTH_TIMEOUT_SECONDS=180
LOG_TAIL_LINES=100
CADDY_BACKUP_DIR="/var/backups/caddy-guess-the-melody"
CADDY_MARKER="# guess-the-melody managed"

HAS_TTY=0
CLEANED=0
SUDO_KEEPALIVE_PID=""
SUDO_PREFIX=""
TEMP_FILES=()
CADDY_TEMP_FILES=()
env_file=""
DOMAIN_DEFAULT="${DOMAIN}"
EMAIL_DEFAULT="${ACME_EMAIL}"
PORT_DEFAULT="${APP_HOST_PORT}"
MODE_DEFAULT="${AUDIO_DELIVERY_MODE}"
OS_ID=""
OS_CODENAME=""
PORT_CHECK_TOOL=""
PREVIOUS_DOMAIN=""
CADDY_SITE_PATH=""
CADDY_SITE_BACKUP=""
CADDY_SITE_EXISTED=0
CADDY_OLD_SITE_PATH=""
CADDY_OLD_SITE_BACKUP=""
CADDY_MAIN_BACKUP=""
CADDY_MAIN_EXISTED=0
CADDY_MAIN_MODIFIED=0
CADDY_MAIN_BACKED_UP=0
CADDY_IMPORT_ADDED=0
CADDY_CHANGES_APPLIED=0
CADDY_CONFIG_VALID=0
CADDY_VALIDATE_OUTPUT=""
CADDY_CONFLICT_FILE=""

say() {
  printf '==> %s\n' "$*"
}

say_err() {
  printf 'Ошибка: %s\n' "$*" >&2
}

die() {
  say_err "$*"
  exit 1
}

cleanup() {
  local f
  if (( CLEANED == 1 )); then
    return 0
  fi
  CLEANED=1
  if (( CADDY_CHANGES_APPLIED == 1 && CADDY_CONFIG_VALID == 0 )); then
    caddy_rollback
  fi
  if (( ${#CADDY_TEMP_FILES[@]} > 0 )); then
    for f in "${CADDY_TEMP_FILES[@]}"; do
      if [[ -n "$f" ]]; then
        run_root rm -f -- "$f" 2>/dev/null || true
      fi
    done
  fi
  if [[ -n "$SUDO_KEEPALIVE_PID" ]]; then
    kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
  fi
  if (( ${#TEMP_FILES[@]} > 0 )); then
    for f in "${TEMP_FILES[@]}"; do
      if [[ -n "$f" ]]; then
        rm -f -- "$f" 2>/dev/null || true
      fi
    done
  fi
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

detect_tty() {
  if { : >/dev/tty; } 2>/dev/null && { : </dev/tty; } 2>/dev/null; then
    HAS_TTY=1
  else
    HAS_TTY=0
  fi
}

run_root() {
  if (( EUID == 0 )); then
    "$@" </dev/null
  else
    sudo "$@" </dev/null
  fi
}

setup_root() {
  if (( EUID == 0 )); then
    return 0
  fi
  SUDO_PREFIX="sudo "
  if ! command -v sudo >/dev/null 2>&1; then
    die "Нужны права root: запустите установщик от root или установите sudo."
  fi
  if sudo -n true </dev/null >/dev/null 2>&1; then
    return 0
  fi
  if (( HAS_TTY == 0 )); then
    die "sudo требует пароль, но терминал недоступен. Запустите установщик в интерактивном терминале или от root."
  fi
  say "Для установки нужны права root: запрашиваю пароль sudo (один раз)."
  if ! sudo -v; then
    die "Не удалось получить права sudo."
  fi
  ( while sleep 50; do sudo -n true </dev/null >/dev/null 2>&1 || break; done ) </dev/null &
  SUDO_KEEPALIVE_PID=$!
}

read_os_release() {
  if [[ ! -r /etc/os-release ]]; then
    die "Не удалось прочитать /etc/os-release. Поддерживаются Debian и Ubuntu с systemd."
  fi
  OS_ID=$(awk -F= '$1 == "ID" { gsub(/"/, "", $2); print $2; exit }' /etc/os-release)
  OS_CODENAME=$(awk -F= '$1 == "VERSION_CODENAME" { gsub(/"/, "", $2); print $2; exit }' /etc/os-release)
}

check_os() {
  read_os_release
  case "$OS_ID" in
    debian | ubuntu) ;;
    *)
      die "Поддерживаются только Debian и Ubuntu с systemd (обнаружено: ${OS_ID:-неизвестно}). Установите Docker Compose v2 и Caddy вручную или используйте поддерживаемый дистрибутив."
      ;;
  esac
  if ! command -v systemctl >/dev/null 2>&1 || [[ ! -d /run/systemd/system ]]; then
    die "Не обнаружен systemd (${OS_ID:-неизвестная система}). Установщик требует Debian или Ubuntu с systemd."
  fi
  if ! command -v apt-get >/dev/null 2>&1; then
    die "Не найден apt-get. Поддерживаются только Debian и Ubuntu."
  fi
  say "Система: ${OS_ID}${OS_CODENAME:+ (${OS_CODENAME})}."
}

ensure_base_tools() {
  local missing=()
  if ! command -v git >/dev/null 2>&1; then
    missing+=("git")
  fi
  if ! command -v curl >/dev/null 2>&1; then
    missing+=("curl")
  fi
  if (( ${#missing[@]} > 0 )); then
    die "Не найдены обязательные программы: ${missing[*]}. Установите их: apt-get update && apt-get install -y ${missing[*]}"
  fi
}

confirm() {
  local question=$1 answer=""
  if (( HAS_TTY == 0 )); then
    say "Нет терминала для подтверждения: ${question}"
    return 1
  fi
  printf '%s [y/N]: ' "$question" > /dev/tty
  IFS= read -r answer < /dev/tty || answer=""
  case "$answer" in
    y | Y | yes | Yes | YES | д | Д | да | Да | ДА) return 0 ;;
    *) return 1 ;;
  esac
}

docker_present() {
  command -v docker >/dev/null 2>&1
}

compose_v2_present() {
  docker_present || return 1
  run_root docker compose version >/dev/null 2>&1
}

install_docker() {
  local arch="" key_tmp="" list_tmp=""
  say "Устанавливаю Docker из официального репозитория..."
  if [[ -z "$OS_CODENAME" ]]; then
    die "Не удалось определить кодовое имя дистрибутива из /etc/os-release. Установите Docker вручную: https://docs.docker.com/engine/install/"
  fi
  arch=$(dpkg --print-architecture </dev/null)
  key_tmp=$(mktemp)
  TEMP_FILES+=("$key_tmp")
  list_tmp=$(mktemp)
  TEMP_FILES+=("$list_tmp")
  run_root install -m 0755 -d /etc/apt/keyrings
  if ! run_root apt-get update -qq; then
    die "Не удалось обновить список пакетов (apt-get update). Проверьте доступ к репозиториям Debian/Ubuntu."
  fi
  if ! run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates; then
    die "Не удалось установить ca-certificates (нужен для HTTPS-загрузки ключа Docker)."
  fi
  if ! curl -fsSL "https://download.docker.com/linux/${OS_ID}/gpg" -o "$key_tmp" </dev/null; then
    die "Не удалось скачать GPG-ключ репозитория Docker с https://download.docker.com."
  fi
  run_root install -m 0644 "$key_tmp" /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$arch" "$OS_ID" "$OS_CODENAME" >"$list_tmp"
  run_root install -m 0644 "$list_tmp" /etc/apt/sources.list.d/docker.list
  if ! run_root apt-get update -qq; then
    die "Не удалось обновить список пакетов (apt-get update) после подключения репозитория Docker. Проверьте доступ к https://download.docker.com."
  fi
  if ! run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then
    die "Не удалось установить Docker. Установите вручную: https://docs.docker.com/engine/install/"
  fi
}

install_caddy() {
  local key_tmp="" list_tmp=""
  say "Устанавливаю Caddy из официального репозитория..."
  key_tmp=$(mktemp)
  TEMP_FILES+=("$key_tmp")
  list_tmp=$(mktemp)
  TEMP_FILES+=("$list_tmp")
  if ! run_root apt-get update -qq; then
    die "Не удалось обновить список пакетов (apt-get update). Проверьте доступ к репозиториям Debian/Ubuntu."
  fi
  if ! run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gnupg; then
    die "Не удалось установить gnupg (нужен для импорта ключа репозитория Caddy)."
  fi
  if ! curl -fsSL "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" -o "$key_tmp" </dev/null; then
    die "Не удалось скачать GPG-ключ репозитория Caddy с https://dl.cloudsmith.io."
  fi
  if ! run_root gpg --batch --yes --no-tty --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg "$key_tmp"; then
    die "Не удалось импортировать GPG-ключ репозитория Caddy в /usr/share/keyrings/caddy-stable-archive-keyring.gpg."
  fi
  run_root chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  printf 'deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main\n' >"$list_tmp"
  run_root install -m 0644 "$list_tmp" /etc/apt/sources.list.d/caddy-stable.list
  if ! run_root apt-get update -qq; then
    die "Не удалось обновить список пакетов (apt-get update) после подключения репозитория Caddy. Проверьте доступ к https://dl.cloudsmith.io."
  fi
  if ! run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y caddy; then
    die "Не удалось установить Caddy. Установите вручную: https://caddyserver.com/docs/install"
  fi
}

ensure_docker_running() {
  local waited=0
  if run_root docker info >/dev/null 2>&1; then
    return 0
  fi
  say "Служба Docker не отвечает: пробую запустить docker.service."
  run_root systemctl enable --now docker >/dev/null 2>&1 || true
  while (( waited < 20 )); do
    if run_root docker info >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  die "Docker не отвечает. Проверьте службу: systemctl status docker"
}

ensure_docker() {
  if docker_present && compose_v2_present; then
    ensure_docker_running
    return 0
  fi
  if ! confirm "Docker или Docker Compose v2 не найдены. Установить Docker из официального репозитория Docker?"; then
    die "Docker и Compose v2 обязательны. Установите их по инструкции https://docs.docker.com/engine/install/ и запустите установщик снова."
  fi
  install_docker
  if ! docker_present || ! compose_v2_present; then
    die "Docker установлен, но команда 'docker compose' недоступна. Проверьте пакет docker-compose-plugin."
  fi
  ensure_docker_running
}

ensure_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    return 0
  fi
  if ! confirm "Caddy не найден. Установить Caddy из официального репозитория Caddy?"; then
    die "Caddy обязателен для HTTPS. Установите его по инструкции https://caddyserver.com/docs/install и запустите установщик снова."
  fi
  install_caddy
  if ! command -v caddy >/dev/null 2>&1; then
    die "Caddy установлен, но команда caddy недоступна в PATH."
  fi
}

domain_slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E -e 's/[^a-z0-9]+/-/g' -e 's/^-+//' -e 's/-+$//'
}

is_valid_domain() {
  local name=$1
  [[ "${#name}" -ge 3 && "${#name}" -le 253 ]] || return 1
  [[ "$name" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]
}

is_valid_email() {
  local address=$1 local_part="" domain_part=""
  [[ "$address" == *"@"* ]] || return 1
  [[ "$address" != *" "* && "$address" != *"@"*"@"* ]] || return 1
  local_part=${address%%@*}
  domain_part=${address#*@}
  [[ -n "$local_part" && -n "$domain_part" ]] || return 1
  [[ "$domain_part" == *.* ]] || return 1
  [[ "$address" =~ ^[A-Za-z0-9._%+@-]+$ ]]
}

validate_port_value() {
  local raw=$1
  [[ "$raw" =~ ^[0-9]{1,5}$ ]] || return 1
  (( 10#$raw >= 1 && 10#$raw <= 65535 ))
}

bash_has_dev_tcp() {
  local message=""
  message=$( { : >"/dev/tcp/127.0.0.1/1"; } 2>&1 || true )
  [[ "$message" != *"No such file or directory"* && "$message" != *"Нет такого файла"* ]]
}

detect_port_check_tool() {
  if command -v ss >/dev/null 2>&1; then
    PORT_CHECK_TOOL="ss"
    return 0
  fi
  if command -v netstat >/dev/null 2>&1; then
    PORT_CHECK_TOOL="netstat"
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    PORT_CHECK_TOOL="lsof"
    return 0
  fi
  if bash_has_dev_tcp; then
    PORT_CHECK_TOOL="devtcp"
    return 0
  fi
  PORT_CHECK_TOOL="none"
  return 1
}

warn_port_check_unavailable() {
  if [[ "$PORT_CHECK_TOOL" == "none" ]]; then
    say "Внимание: не найдены ss, netstat и lsof, а /dev/tcp недоступен — проверить занятость порта невозможно, продолжаю без этой проверки."
  fi
}

port_in_use() {
  local port=$1
  case "$PORT_CHECK_TOOL" in
    ss)
      if ss -ltn 2>/dev/null | awk -v p=":${port}" 'NR > 1 && $4 ~ (p "$") { found = 1 } END { exit(found ? 0 : 1) }'; then
        return 0
      fi
      return 1
      ;;
    netstat)
      if netstat -ltn 2>/dev/null | awk -v p=":${port}" '$4 ~ (p "$") { found = 1 } END { exit(found ? 0 : 1) }'; then
        return 0
      fi
      return 1
      ;;
    lsof)
      if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        return 0
      fi
      return 1
      ;;
    devtcp)
      if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
        return 0
      fi
      return 1
      ;;
    *)
      return 1
      ;;
  esac
}

next_free_port() {
  local candidate
  candidate=$(($1 + 1))
  while (( candidate <= 65535 )); do
    if ! port_in_use "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
  done
  return 1
}

project_owns_port() {
  local port=$1 ports=""
  docker_present || return 1
  ports=$(run_root docker ps --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --format '{{.Ports}}' 2>/dev/null || true)
  if [[ -z "$ports" ]]; then
    return 1
  fi
  grep -Fq "127.0.0.1:${port}->" <<<"$ports"
}

port_is_available() {
  local port=$1
  if ! port_in_use "$port"; then
    return 0
  fi
  if project_owns_port "$port"; then
    return 0
  fi
  return 1
}

env_value_from_file() {
  local file=$1 key=$2 content=""
  [[ -f "$file" ]] || return 0
  if [[ -r "$file" ]]; then
    content=$(cat -- "$file" 2>/dev/null || true)
  else
    content=$(run_root cat -- "$file" 2>/dev/null || true)
  fi
  if [[ -z "$content" ]]; then
    return 0
  fi
  awk -v k="$key" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { print v }' <<<"$content" | tr -d '\r'
}

env_set_value_in() {
  local file=$1 key=$2 value=$3 next=""
  next="${file}.next"
  TEMP_FILES+=("$next")
  if ! (
    umask 077
    NEW_KEY="$key" NEW_VALUE="$value" awk '
      BEGIN {
        k = ENVIRON["NEW_KEY"]
        v = ENVIRON["NEW_VALUE"]
        done = 0
      }
      index($0, k "=") == 1 {
        if (!done) {
          print k "=" v
          done = 1
        }
        next
      }
      { print }
      END {
        if (!done) {
          print k "=" v
        }
      }
    ' "$file" >"$next"
  ); then
    rm -f -- "$next"
    die "Не удалось обновить ${file}."
  fi
  mv -f -- "$next" "$file"
}

ensure_env_key() {
  local file=$1 key=$2 value=$3 next=""
  next="${file}.next"
  TEMP_FILES+=("$next")
  if ! (
    umask 077
    NEW_KEY="$key" NEW_VALUE="$value" awk '
      BEGIN {
        k = ENVIRON["NEW_KEY"]
        v = ENVIRON["NEW_VALUE"]
        found = 0
      }
      index($0, k "=") == 1 { found = 1 }
      { print }
      END {
        if (!found) {
          print k "=" v
        }
      }
    ' "$file" >"$next"
  ); then
    rm -f -- "$next"
    die "Не удалось обновить ${file}."
  fi
  mv -f -- "$next" "$file"
}

write_env_skeleton() {
  local file=$1
  {
    printf 'PORT=%s\n' "$DEFAULT_APP_PORT"
    printf 'HOST=0.0.0.0\n'
    printf 'ROOM_DB_PATH=./data/rooms.sqlite\n'
    printf 'ROOM_TTL_HOURS=72\n'
    printf 'YANDEX_MUSIC_TOKEN=\n'
    printf 'YANDEX_MUSIC_USE_DEMO=false\n'
    printf 'YANDEX_MUSIC_ALLOW_FULL_TRACK_FALLBACK=false\n'
    printf 'AUDIO_DELIVERY_MODE=%s\n' "$DEFAULT_AUDIO_MODE"
    printf 'AUDIO_CACHE_MAX_BYTES=8000000\n'
    printf 'AUDIO_CACHE_LOOKAHEAD=2\n'
    printf 'ROUND_AUDIO_WARMUP_MS=\n'
  } >"$file"
}

write_env_file() {
  local tmp=""
  tmp=$(mktemp)
  TEMP_FILES+=("$tmp")
  if [[ -f "$env_file" ]]; then
    if [[ -r "$env_file" ]]; then
      cat -- "$env_file" >"$tmp"
    else
      run_root cat -- "$env_file" >"$tmp" 2>/dev/null || true
    fi
  elif [[ -f "${INSTALL_DIR}/.env.example" ]]; then
    cat -- "${INSTALL_DIR}/.env.example" >"$tmp"
  else
    write_env_skeleton "$tmp"
  fi

  ensure_env_key "$tmp" PORT "$DEFAULT_APP_PORT"
  ensure_env_key "$tmp" HOST "0.0.0.0"
  ensure_env_key "$tmp" ROOM_DB_PATH "./data/rooms.sqlite"
  ensure_env_key "$tmp" ROOM_TTL_HOURS "72"
  ensure_env_key "$tmp" YANDEX_MUSIC_TOKEN ""
  ensure_env_key "$tmp" YANDEX_MUSIC_USE_DEMO "false"
  ensure_env_key "$tmp" YANDEX_MUSIC_ALLOW_FULL_TRACK_FALLBACK "false"
  ensure_env_key "$tmp" AUDIO_DELIVERY_MODE "$DEFAULT_AUDIO_MODE"
  ensure_env_key "$tmp" AUDIO_CACHE_MAX_BYTES "8000000"
  ensure_env_key "$tmp" AUDIO_CACHE_LOOKAHEAD "2"
  ensure_env_key "$tmp" ROUND_AUDIO_WARMUP_MS ""

  env_set_value_in "$tmp" CLIENT_ORIGIN "https://${DOMAIN}"
  env_set_value_in "$tmp" APP_HOST_PORT "$APP_HOST_PORT"
  env_set_value_in "$tmp" APP_DOMAIN "$DOMAIN"
  env_set_value_in "$tmp" ACME_EMAIL "$ACME_EMAIL"
  env_set_value_in "$tmp" COMPOSE_PROJECT_NAME "$COMPOSE_PROJECT_NAME"
  env_set_value_in "$tmp" AUDIO_DELIVERY_MODE "$AUDIO_DELIVERY_MODE"
  if [[ -n "$YANDEX_MUSIC_TOKEN" ]]; then
    env_set_value_in "$tmp" YANDEX_MUSIC_TOKEN "$YANDEX_MUSIC_TOKEN"
  fi

  run_root mkdir -p -- "$(dirname -- "$env_file")"
  run_root install -m 600 "$tmp" "$env_file"
  rm -f -- "$tmp"
  say "Файл окружения готов: ${env_file} (права 600)."
}

resolve_install_dir() {
  local slug="" base_domain="" target_domain=""
  slug=$(domain_slug "$DOMAIN")
  if [[ -z "$INSTALL_DIR" ]]; then
    if [[ -d "$BASE_INSTALL_DIR" ]]; then
      base_domain=$(env_value_from_file "${BASE_INSTALL_DIR}/.env" APP_DOMAIN)
      if [[ -n "$base_domain" && "$base_domain" != "$DOMAIN" ]]; then
        INSTALL_DIR="${BASE_INSTALL_DIR}-${slug}"
      else
        INSTALL_DIR="$BASE_INSTALL_DIR"
      fi
    else
      INSTALL_DIR="$BASE_INSTALL_DIR"
    fi
  fi
  INSTALL_DIR=${INSTALL_DIR%/}
  env_file="${INSTALL_DIR}/.env"
  if [[ -f "$env_file" ]]; then
    target_domain=$(env_value_from_file "$env_file" APP_DOMAIN)
    if [[ -n "$target_domain" ]]; then
      PREVIOUS_DOMAIN=$target_domain
    fi
    if [[ -n "$target_domain" && "$target_domain" != "$DOMAIN" ]]; then
      if [[ "$ALLOW_DOMAIN_CHANGE" != "1" ]]; then
        die "Каталог ${INSTALL_DIR} уже настроен для домена ${target_domain}. Для домена ${DOMAIN} задайте другой INSTALL_DIR (например ${BASE_INSTALL_DIR}-${slug}) и COMPOSE_PROJECT_NAME. Смена домена существующего экземпляра: ALLOW_DOMAIN_CHANGE=1."
      fi
      say "Домен экземпляра меняется: ${target_domain} -> ${DOMAIN} (ALLOW_DOMAIN_CHANGE=1)."
    fi
  fi
  if [[ -z "$COMPOSE_PROJECT_NAME" ]]; then
    case "$INSTALL_DIR" in
      "$BASE_INSTALL_DIR")
        COMPOSE_PROJECT_NAME="guess-the-melody"
        ;;
      "$BASE_INSTALL_DIR"-*)
        COMPOSE_PROJECT_NAME="guess-the-melody-${INSTALL_DIR#"$BASE_INSTALL_DIR"-}"
        ;;
      *)
        COMPOSE_PROJECT_NAME="guess-the-melody-${slug}"
        ;;
    esac
  fi
}

prepare_defaults() {
  local base_domain=""
  if [[ -z "$DOMAIN_DEFAULT" && -f "${BASE_INSTALL_DIR}/.env" ]]; then
    base_domain=$(env_value_from_file "${BASE_INSTALL_DIR}/.env" APP_DOMAIN)
    if [[ -n "$base_domain" ]]; then
      DOMAIN_DEFAULT=$base_domain
    fi
  fi
}

load_env_defaults() {
  local value=""
  value=$(env_value_from_file "$env_file" ACME_EMAIL)
  if [[ -n "$value" && -z "$EMAIL_DEFAULT" ]]; then
    EMAIL_DEFAULT=$value
  fi
  value=$(env_value_from_file "$env_file" APP_HOST_PORT)
  if [[ -n "$value" && -z "$PORT_DEFAULT" ]]; then
    PORT_DEFAULT=$value
  fi
  value=$(env_value_from_file "$env_file" AUDIO_DELIVERY_MODE)
  if [[ -n "$value" && -z "$MODE_DEFAULT" ]]; then
    MODE_DEFAULT=$value
  fi
}

ask_with_default() {
  local label=$1 default=$2 answer=""
  printf '%s (%s): ' "$label" "${default:-обязательно}" >/dev/tty
  if ! IFS= read -r answer < /dev/tty; then
    die "Ввод с терминала недоступен. Запустите установщик в интерактивном терминале или задайте переменные окружения."
  fi
  REPLY=${answer:-$default}
}

ask_domain() {
  local candidate=""
  while :; do
    ask_with_default "Домен игры без схемы" "$DOMAIN_DEFAULT"
    candidate=$(printf '%s' "$REPLY" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
    if [[ -z "$candidate" ]]; then
      say_err "Домен обязателен."
      continue
    fi
    if [[ "$candidate" == *"://"* ]]; then
      say_err "Укажите домен без схемы: melody.example.com, а не https://melody.example.com."
      continue
    fi
    if ! is_valid_domain "$candidate"; then
      say_err "Некорректный домен: ${candidate}. Нужен hostname вида melody.example.com."
      continue
    fi
    DOMAIN=$candidate
    return 0
  done
}

ask_email() {
  local candidate=""
  while :; do
    ask_with_default "E-mail для Let's Encrypt" "$EMAIL_DEFAULT"
    candidate=$(printf '%s' "$REPLY" | tr -d '[:space:]')
    if [[ -z "$candidate" ]]; then
      say_err "E-mail обязателен для выдачи сертификата."
      continue
    fi
    if ! is_valid_email "$candidate"; then
      say_err "Некорректный e-mail: укажите адрес вида admin@example.com."
      continue
    fi
    ACME_EMAIL=$candidate
    return 0
  done
}

ask_port() {
  local raw="" suggestion="" default=$DEFAULT_APP_PORT
  default=${PORT_DEFAULT:-$DEFAULT_APP_PORT}
  warn_port_check_unavailable
  while :; do
    ask_with_default "Порт приложения на 127.0.0.1" "$default"
    raw=$(printf '%s' "$REPLY" | tr -d '[:space:]')
    if ! validate_port_value "$raw"; then
      say_err "Порт должен быть целым числом от 1 до 65535."
      continue
    fi
    APP_HOST_PORT=$((10#$raw))
    if port_is_available "$APP_HOST_PORT"; then
      return 0
    fi
    suggestion=$(next_free_port "$APP_HOST_PORT" || true)
    if [[ -n "$suggestion" ]]; then
      say_err "Порт ${APP_HOST_PORT} занят другим процессом. Предлагаю свободный порт ${suggestion}."
      default=$suggestion
    else
      say_err "Порт ${APP_HOST_PORT} занят другим процессом, свободного порта рядом нет."
    fi
  done
}

ask_mode() {
  local default=$DEFAULT_AUDIO_MODE answer=""
  default=${MODE_DEFAULT:-$DEFAULT_AUDIO_MODE}
  while :; do
    ask_with_default "Режим аудио AUDIO_DELIVERY_MODE: direct или cache" "$default"
    answer=$(printf '%s' "$REPLY" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
    case "$answer" in
      direct | cache)
        AUDIO_DELIVERY_MODE=$answer
        return 0
        ;;
      *)
        say_err "Допустимые значения: direct или cache."
        ;;
    esac
  done
}

ask_token() {
  local answer="" hint="не задан" existing="" env_token=""
  env_token=$YANDEX_MUSIC_TOKEN
  existing=$(env_value_from_file "$env_file" YANDEX_MUSIC_TOKEN)
  if [[ -n "$env_token" ]]; then
    hint="из переменной окружения"
  elif [[ -n "$existing" ]]; then
    hint="оставить текущий"
  fi
  printf 'YANDEX_MUSIC_TOKEN (необязательно, %s, ввод скрыт): ' "$hint" >/dev/tty
  if ! IFS= read -rs answer < /dev/tty; then
    printf '\n' >/dev/tty
    die "Ввод с терминала недоступен. Запустите установщик в интерактивном терминале."
  fi
  printf '\n' >/dev/tty
  answer=$(printf '%s' "$answer" | tr -d '[:space:]')
  if [[ -n "$answer" ]]; then
    YANDEX_MUSIC_TOKEN=$answer
  elif [[ -n "$env_token" ]]; then
    YANDEX_MUSIC_TOKEN=$env_token
  else
    YANDEX_MUSIC_TOKEN=$existing
  fi
}

collect_interactive() {
  ask_domain
  resolve_install_dir
  load_env_defaults
  ask_email
  ask_port
  ask_mode
  ask_token
}

collect_noninteractive() {
  local value=""
  say "Терминал недоступен: значения берутся из переменных окружения."
  warn_port_check_unavailable
  DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  if [[ -z "$DOMAIN" ]]; then
    die "Не задан DOMAIN. Для неинтерактивной установки задайте DOMAIN и ACME_EMAIL."
  fi
  if ! is_valid_domain "$DOMAIN"; then
    die "Некорректный DOMAIN: ${DOMAIN}. Нужен hostname без схемы, например melody.example.com."
  fi
  resolve_install_dir
  if [[ -z "$ACME_EMAIL" ]]; then
    value=$(env_value_from_file "$env_file" ACME_EMAIL)
    ACME_EMAIL=$value
  fi
  if [[ -z "$ACME_EMAIL" ]]; then
    die "Не задан ACME_EMAIL. Для неинтерактивной установки задайте DOMAIN и ACME_EMAIL."
  fi
  if ! is_valid_email "$ACME_EMAIL"; then
    die "Некорректный ACME_EMAIL: укажите адрес вида admin@example.com."
  fi
  if [[ -z "$APP_HOST_PORT" ]]; then
    value=$(env_value_from_file "$env_file" APP_HOST_PORT)
    APP_HOST_PORT=${value:-$DEFAULT_APP_PORT}
  fi
  if ! validate_port_value "$APP_HOST_PORT"; then
    die "APP_HOST_PORT должен быть целым числом от 1 до 65535."
  fi
  APP_HOST_PORT=$((10#$APP_HOST_PORT))
  if [[ -z "$AUDIO_DELIVERY_MODE" ]]; then
    value=$(env_value_from_file "$env_file" AUDIO_DELIVERY_MODE)
    AUDIO_DELIVERY_MODE=${value:-$DEFAULT_AUDIO_MODE}
  fi
  case "$AUDIO_DELIVERY_MODE" in
    direct | cache) ;;
    *) die "AUDIO_DELIVERY_MODE должен быть direct или cache." ;;
  esac
  if port_in_use "$APP_HOST_PORT" && ! project_owns_port "$APP_HOST_PORT"; then
    die "Порт ${APP_HOST_PORT} занят другим процессом. Укажите свободный APP_HOST_PORT."
  fi
  if [[ -z "$YANDEX_MUSIC_TOKEN" ]]; then
    YANDEX_MUSIC_TOKEN=$(env_value_from_file "$env_file" YANDEX_MUSIC_TOKEN)
  fi
}

git_in() {
  run_root git -c "safe.directory=${INSTALL_DIR}" -C "$INSTALL_DIR" "$@"
}

dir_is_empty() {
  [[ -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]
}

fetch_code() {
  run_root mkdir -p -- "$(dirname -- "$INSTALL_DIR")"
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    say "Обновляю существующую копию проекта в ${INSTALL_DIR}..."
    if [[ -n "$REPO_URL" ]]; then
      if ! git_in remote set-url origin "$REPO_URL" 2>/dev/null; then
        git_in remote add origin "$REPO_URL" 2>/dev/null || true
      fi
    fi
    if ! git_in fetch --prune --tags origin "+refs/heads/*:refs/remotes/origin/*"; then
      die "Не удалось получить обновления из origin в ${INSTALL_DIR}. Проверьте доступ к репозиторию."
    fi
    if git_in show-ref --verify --quiet "refs/remotes/origin/${REPO_REF}"; then
      if ! git_in checkout -q -B "$REPO_REF" "origin/${REPO_REF}"; then
        die "Не удалось переключить ${INSTALL_DIR} на ветку ${REPO_REF}. Проверьте локальные изменения в каталоге установки."
      fi
    else
      if ! git_in checkout -q --detach "refs/tags/${REPO_REF}" 2>/dev/null && ! git_in checkout -q --detach "$REPO_REF" 2>/dev/null; then
        die "Не удалось переключить ${INSTALL_DIR} на ${REPO_REF}: ветка origin/${REPO_REF} и тег ${REPO_REF} не найдены. Проверьте REPO_REF и доступ к репозиторию."
      fi
    fi
  elif [[ -d "$INSTALL_DIR" ]] && ! dir_is_empty "$INSTALL_DIR"; then
    if [[ ! -f "${INSTALL_DIR}/compose.yaml" ]]; then
      die "Каталог ${INSTALL_DIR} существует, но не является копией проекта. Укажите другой каталог через INSTALL_DIR."
    fi
    say "Каталог ${INSTALL_DIR} уже существует: использую его без git clone."
  else
    say "Клонирую ${REPO_URL} (ветка ${REPO_REF}) в ${INSTALL_DIR}..."
    if ! run_root git clone --branch "$REPO_REF" --depth 1 "$REPO_URL" "$INSTALL_DIR"; then
      die "Не удалось склонировать ${REPO_URL}. Проверьте REPO_URL, REPO_REF и доступ к репозиторию."
    fi
  fi
  if [[ ! -f "${INSTALL_DIR}/compose.yaml" ]]; then
    die "В ${INSTALL_DIR} нет compose.yaml. Проверьте REPO_URL и REPO_REF."
  fi
}

compose() {
  run_root docker compose \
    --project-directory "$INSTALL_DIR" \
    -f "${INSTALL_DIR}/compose.yaml" \
    --env-file "$env_file" \
    -p "$COMPOSE_PROJECT_NAME" \
    "$@"
}

fail_app() {
  local message=$1
  say_err "$message"
  compose ps || true
  compose logs --tail="$LOG_TAIL_LINES" || true
  say_err "Логи: cd ${INSTALL_DIR} && ${SUDO_PREFIX}docker compose logs --tail=${LOG_TAIL_LINES}"
  die "Приложение не готово. Исправьте проблему и запустите установщик снова."
}

start_app() {
  say "Собираю образ и запускаю контейнер: docker compose up -d --build"
  if ! compose up -d --build; then
    fail_app "Команда docker compose up -d --build завершилась с ошибкой."
  fi
}

wait_for_health() {
  local waited=0 cid="" status="" services=""
  say "Ожидаю готовности контейнера (до ${HEALTH_TIMEOUT_SECONDS} с)..."
  while (( waited < HEALTH_TIMEOUT_SECONDS )); do
    cid=$(compose ps -q app 2>/dev/null | head -n 1 || true)
    if [[ -n "$cid" ]]; then
      status=$(run_root docker inspect \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        "$cid" 2>/dev/null || true)
      case "$status" in
        healthy)
          break
          ;;
        unhealthy)
          fail_app "Контейнер в статусе unhealthy: он не прошёл проверку здоровья."
          ;;
      esac
    else
      services=$(compose ps -a --format '{{.Service}} {{.State}}' 2>/dev/null || true)
      case "$services" in
        *"app exited"* | *"app dead"*)
          fail_app "Контейнер приложения остановился (exited/dead) и не проходит healthcheck."
          ;;
      esac
    fi
    sleep 3
    waited=$((waited + 3))
  done
  if [[ "$status" != "healthy" ]]; then
    fail_app "Контейнер не перешёл в статус healthy (текущий статус: ${status:-неизвестен})."
  fi
  waited=0
  while (( waited < 30 )); do
    if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:${APP_HOST_PORT}/api/health" </dev/null; then
      say "Приложение отвечает: http://127.0.0.1:${APP_HOST_PORT}/api/health"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  fail_app "Приложение не отвечает на http://127.0.0.1:${APP_HOST_PORT}/api/health."
}

caddy_site_name() {
  local domain=$1
  printf '%s.caddy' "$(printf '%s' "$domain" | tr '.' '_')"
}

caddy_snapshot() {
  local out=$1 file
  : >"$out"
  if run_root test -e "$CADDYFILE"; then
    run_root sha256sum -- "$CADDYFILE" >>"$out" 2>/dev/null || true
  fi
  if run_root test -d "$CADDY_SITES_DIR"; then
    while IFS= read -r -d '' file; do
      if [[ -n "$file" ]]; then
        run_root sha256sum -- "$file" >>"$out" 2>/dev/null || true
      fi
    done < <(run_root find "$CADDY_SITES_DIR" -maxdepth 1 -type f -print0 2>/dev/null || true)
  fi
}

caddy_file_declares_domain() {
  local domain_re=$1 file=$2
  run_root awk -v re="(^|[^a-z0-9.-])${domain_re}([^a-z0-9.-]|$)" '
    $0 !~ /^[[:space:]]*#/ && tolower($0) ~ re && index($0, "{") > 0 { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$file" 2>/dev/null
}

caddy_domain_conflict() {
  local domain_re="" file=""
  domain_re=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed 's/\./[.]/g')
  CADDY_CONFLICT_FILE=""
  if [[ "$CADDYFILE" != "$CADDY_SITE_PATH" ]] && run_root test -e "$CADDYFILE"; then
    if caddy_file_declares_domain "$domain_re" "$CADDYFILE"; then
      CADDY_CONFLICT_FILE=$CADDYFILE
      return 0
    fi
  fi
  if run_root test -d "$CADDY_SITES_DIR"; then
    while IFS= read -r -d '' file; do
      if [[ -z "$file" || "$file" == "$CADDY_SITE_PATH" ]]; then
        continue
      fi
      if caddy_file_declares_domain "$domain_re" "$file"; then
        CADDY_CONFLICT_FILE=$file
        return 0
      fi
    done < <(run_root find "$CADDY_SITES_DIR" -maxdepth 1 -type f -print0 2>/dev/null || true)
  fi
  return 1
}

caddy_atomic_write() {
  local destination=$1 mode=$2 source=$3 dir="" base="" parent="" staging=""
  dir=$(dirname -- "$destination")
  base=$(basename -- "$destination")
  run_root mkdir -p -- "$dir"
  if [[ "$dir" == "$CADDY_SITES_DIR" ]]; then
    parent=$(dirname -- "$dir")
    if [[ "$parent" == "$CADDY_SITES_DIR" ]]; then
      parent="$CADDY_BACKUP_DIR"
      run_root install -d -m 0700 "$CADDY_BACKUP_DIR"
    fi
    staging="${parent}/.${base}.guess-the-melody.$$.tmp"
  else
    staging="${dir}/.${base}.guess-the-melody.$$.tmp"
  fi
  CADDY_TEMP_FILES+=("$staging")
  run_root cp -- "$source" "$staging"
  run_root chmod -- "$mode" "$staging"
  run_root mv -f -- "$staging" "$destination"
}

caddy_backup_main() {
  local stamp=""
  if (( CADDY_MAIN_BACKED_UP == 1 )); then
    return 0
  fi
  stamp=$(date -u +%Y%m%dT%H%M%S%NZ)
  run_root install -d -m 0700 "$CADDY_BACKUP_DIR"
  if run_root test -e "$CADDYFILE"; then
    CADDY_MAIN_BACKUP="${CADDY_BACKUP_DIR}/Caddyfile.${stamp}.bak"
    run_root cp -p -- "$CADDYFILE" "$CADDY_MAIN_BACKUP"
    say "Резервная копия основного Caddyfile: ${CADDY_MAIN_BACKUP}"
  fi
  CADDY_MAIN_BACKED_UP=1
}

caddy_backup_site() {
  local site=$1 stamp=""
  stamp=$(date -u +%Y%m%dT%H%M%S%NZ)
  run_root install -d -m 0700 "$CADDY_BACKUP_DIR"
  CADDY_OLD_SITE_BACKUP="${CADDY_BACKUP_DIR}/site-$(basename -- "$site").${stamp}.bak"
  run_root cp -p -- "$site" "$CADDY_OLD_SITE_BACKUP"
  say "Резервная копия прежнего сайт-файла: ${CADDY_OLD_SITE_BACKUP}"
}

caddy_backup_current_site() {
  local site=$1 stamp=""
  stamp=$(date -u +%Y%m%dT%H%M%S%NZ)
  run_root install -d -m 0700 "$CADDY_BACKUP_DIR"
  CADDY_SITE_BACKUP="${CADDY_BACKUP_DIR}/site-current-$(basename -- "$site").${stamp}.bak"
  run_root cp -p -- "$site" "$CADDY_SITE_BACKUP"
  say "Резервная копия текущего сайт-файла: ${CADDY_SITE_BACKUP}"
}

caddy_has_import() {
  run_root grep -Fxq -- "import ${CADDY_SITES_DIR}/*" "$CADDYFILE" 2>/dev/null
}

caddy_ensure_import() {
  local tmp="" mode="0644" marker_present=0
  if run_root test -e "$CADDYFILE" && caddy_has_import; then
    say "Основной Caddyfile уже подключает ${CADDY_SITES_DIR}: строка import не добавляется."
    return 0
  fi
  caddy_backup_main
  if run_root test -e "$CADDYFILE"; then
    mode=$(run_root stat -c '%a' -- "$CADDYFILE" 2>/dev/null || true)
    mode=${mode:-0644}
    if run_root grep -Fxq -- "$CADDY_MARKER" "$CADDYFILE" 2>/dev/null; then
      marker_present=1
    fi
  fi
  tmp=$(mktemp)
  TEMP_FILES+=("$tmp")
  if run_root test -e "$CADDYFILE"; then
    run_root cat -- "$CADDYFILE" >"$tmp"
  fi
  if [[ -s "$tmp" ]] && [[ "$(tail -c 1 -- "$tmp" | od -An -tx1 | tr -d ' \n')" != "0a" ]]; then
    printf '\n' >>"$tmp"
  fi
  if (( marker_present == 1 )); then
    printf 'import %s/*\n' "$CADDY_SITES_DIR" >>"$tmp"
  else
    printf '%s\nimport %s/*\n' "$CADDY_MARKER" "$CADDY_SITES_DIR" >>"$tmp"
  fi
  CADDY_IMPORT_ADDED=1
  CADDY_MAIN_MODIFIED=1
  CADDY_CHANGES_APPLIED=1
  caddy_atomic_write "$CADDYFILE" "$mode" "$tmp"
  say "В основной Caddyfile добавлена строка import ${CADDY_SITES_DIR}/*"
}

caddy_write_site() {
  local tmp=""
  tmp=$(mktemp)
  TEMP_FILES+=("$tmp")
  {
    printf '# guess-the-melody managed: %s\n' "$DOMAIN"
    printf '%s {\n' "$DOMAIN"
    printf '    encode gzip\n'
    printf '    reverse_proxy 127.0.0.1:%s\n' "$APP_HOST_PORT"
    printf '    tls %s\n' "$ACME_EMAIL"
    printf '}\n'
  } >"$tmp"
  CADDY_CHANGES_APPLIED=1
  caddy_atomic_write "$CADDY_SITE_PATH" "0644" "$tmp"
  say "Сайт-файл Caddy: ${CADDY_SITE_PATH}"
}

caddy_verify_untouched() {
  local before=$1 after=$2 left="" right=""
  left=$(mktemp)
  TEMP_FILES+=("$left")
  right=$(mktemp)
  TEMP_FILES+=("$right")
  awk -v a="$CADDYFILE" -v b="$CADDY_SITE_PATH" -v c="$CADDY_OLD_SITE_PATH" \
    '$2 != a && $2 != b && (c == "" || $2 != c)' "$before" | sort >"$left"
  awk -v a="$CADDYFILE" -v b="$CADDY_SITE_PATH" -v c="$CADDY_OLD_SITE_PATH" \
    '$2 != a && $2 != b && (c == "" || $2 != c)' "$after" | sort >"$right"
  cmp -s -- "$left" "$right"
}

caddy_verify_main_only_import() {
  local old_tmp="" new_tmp="" line="" content="" diff_line_no=0
  if (( CADDY_MAIN_BACKED_UP == 0 )); then
    return 0
  fi
  old_tmp=$(mktemp)
  TEMP_FILES+=("$old_tmp")
  new_tmp=$(mktemp)
  TEMP_FILES+=("$new_tmp")
  if [[ -n "$CADDY_MAIN_BACKUP" ]] && run_root test -e "$CADDY_MAIN_BACKUP"; then
    run_root cat -- "$CADDY_MAIN_BACKUP" >"$old_tmp"
  fi
  run_root cat -- "$CADDYFILE" >"$new_tmp"
  if [[ -s "$old_tmp" ]] && [[ "$(tail -c 1 -- "$old_tmp" | od -An -tx1 | tr -d ' \n')" != "0a" ]]; then
    printf '\n' >>"$old_tmp"
  fi
  while IFS= read -r line; do
    diff_line_no=$((diff_line_no + 1))
    if (( diff_line_no <= 2 )); then
      continue
    fi
    case "$line" in
      '-'*)
        say_err "Основной Caddyfile изменён не только добавлением import: удалена строка."
        return 1
        ;;
      '+'*)
        content=${line#+}
        case "$content" in
          "$CADDY_MARKER" | "import ${CADDY_SITES_DIR}/*" | "")
            ;;
          *)
            say_err "Основной Caddyfile изменён не только добавлением import."
            return 1
            ;;
        esac
        ;;
    esac
  done < <(diff -u -- "$old_tmp" "$new_tmp" 2>/dev/null || true)
  return 0
}

caddy_validate() {
  local output=""
  say "Проверяю конфигурацию Caddy: caddy validate --config ${CADDYFILE}"
  if output=$(run_root caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1); then
    return 0
  fi
  CADDY_VALIDATE_OUTPUT=$output
  return 1
}

caddy_rollback() {
  if (( CADDY_CHANGES_APPLIED == 0 )); then
    return 0
  fi
  say_err "Откатываю изменения конфигурации Caddy."
  if (( CADDY_SITE_EXISTED == 1 )); then
    if [[ -n "$CADDY_SITE_BACKUP" && -n "$CADDY_SITE_PATH" ]] && run_root test -e "$CADDY_SITE_BACKUP"; then
      run_root cp -p -- "$CADDY_SITE_BACKUP" "$CADDY_SITE_PATH" || true
    fi
  elif [[ -n "$CADDY_SITE_PATH" ]] && run_root test -e "$CADDY_SITE_PATH"; then
    run_root rm -f -- "$CADDY_SITE_PATH" || true
  fi
  if [[ -n "$CADDY_OLD_SITE_PATH" && -n "$CADDY_OLD_SITE_BACKUP" ]] && run_root test -e "$CADDY_OLD_SITE_BACKUP"; then
    run_root cp -p -- "$CADDY_OLD_SITE_BACKUP" "$CADDY_OLD_SITE_PATH" || true
  fi
  if (( CADDY_MAIN_MODIFIED == 1 )); then
    if [[ -n "$CADDY_MAIN_BACKUP" ]] && run_root test -e "$CADDY_MAIN_BACKUP"; then
      run_root cp -p -- "$CADDY_MAIN_BACKUP" "$CADDYFILE" || true
    elif (( CADDY_MAIN_EXISTED == 0 )); then
      run_root rm -f -- "$CADDYFILE" || true
    fi
  fi
  CADDY_CHANGES_APPLIED=0
  CADDY_CONFIG_VALID=0
}

caddy_reload() {
  local units=""
  if ! command -v systemctl >/dev/null 2>&1; then
    say "Внимание: systemd не найден. Перезагрузите Caddy вручную: ${SUDO_PREFIX}caddy reload --config ${CADDYFILE}"
    return 0
  fi
  units=$(run_root systemctl list-unit-files --type=service 2>/dev/null || true)
  if [[ "$units" != *"caddy.service"* ]]; then
    say "Внимание: служба caddy.service не найдена. Перезагрузите Caddy вручную: ${SUDO_PREFIX}caddy reload --config ${CADDYFILE}"
    return 0
  fi
  say "Перезагружаю Caddy: systemctl reload caddy"
  if run_root systemctl reload caddy; then
    say "Caddy перезагружен."
    return 0
  fi
  say "Внимание: systemctl reload caddy завершился с ошибкой. Конфигурация записана и прошла caddy validate; перезагрузите Caddy вручную: ${SUDO_PREFIX}caddy reload --config ${CADDYFILE}"
  return 1
}

caddy_warn_open_ports() {
  local port=""
  if [[ "$PORT_CHECK_TOOL" == "none" ]]; then
    say "Внимание: проверьте, что порты 80 и 443 открыты снаружи (firewall/security group)."
    return 0
  fi
  for port in 80 443; do
    if ! port_in_use "$port"; then
      say "Внимание: локально порт ${port} не прослушивается. Проверьте, что Caddy запущен и порт ${port} открыт снаружи (firewall/security group)."
    fi
  done
}

caddy_public_checks() {
  say "Проверяю HTTPS через Caddy: DNS и выдача сертификата могут занять время."
  if curl -fsS -o /dev/null --max-time 10 "https://${DOMAIN}/api/health" </dev/null; then
    say "HTTPS-проверка /api/health: OK."
  else
    say "Внимание: https://${DOMAIN}/api/health пока не отвечает. Проверьте DNS-запись домена и доступность портов 80/443 снаружи; сертификат Let's Encrypt может выдаваться несколько минут."
  fi
  if curl -fsS -o /dev/null --max-time 10 "https://${DOMAIN}/socket.io/?EIO=4&transport=polling" </dev/null; then
    say "HTTPS-проверка Socket.IO: OK."
  else
    say "Внимание: https://${DOMAIN}/socket.io/ пока не отвечает. Это нормально сразу после установки: проверьте DNS и порты 80/443."
  fi
  caddy_warn_open_ports
}

caddy_setup() {
  local before_snapshot="" after_snapshot=""
  say "Настраиваю Caddy для домена ${DOMAIN}..."
  say "Проверка конфликта домена и сверка неизменности выполняются только для ${CADDYFILE} и ${CADDY_SITES_DIR}; каталоги, подключённые другими директивами import, проверьте вручную."
  CADDY_MAIN_EXISTED=0
  if run_root test -e "$CADDYFILE"; then
    CADDY_MAIN_EXISTED=1
  fi
  CADDY_SITE_PATH="${CADDY_SITES_DIR}/$(caddy_site_name "$DOMAIN")"
  CADDY_SITE_BACKUP=""
  CADDY_SITE_EXISTED=0
  CADDY_OLD_SITE_PATH=""
  if [[ -n "$PREVIOUS_DOMAIN" && "$PREVIOUS_DOMAIN" != "$DOMAIN" ]]; then
    CADDY_OLD_SITE_PATH="${CADDY_SITES_DIR}/$(caddy_site_name "$PREVIOUS_DOMAIN")"
  fi

  before_snapshot=$(mktemp)
  TEMP_FILES+=("$before_snapshot")
  caddy_snapshot "$before_snapshot"

  if caddy_domain_conflict; then
    say_err "Домен ${DOMAIN} уже объявлен в конфигурации Caddy: ${CADDY_CONFLICT_FILE}."
    say_err "Caddy не изменён. Выберите другой домен или вручную удалите конфликтующий сайт и запустите установщик снова."
    exit 1
  fi

  if ! run_root test -d "$CADDY_SITES_DIR"; then
    run_root mkdir -p -- "$CADDY_SITES_DIR"
    run_root chmod 0755 "$CADDY_SITES_DIR"
  fi

  if run_root test -e "$CADDY_SITE_PATH"; then
    CADDY_SITE_EXISTED=1
    caddy_backup_current_site "$CADDY_SITE_PATH"
  fi

  if [[ -n "$CADDY_OLD_SITE_PATH" && "$CADDY_OLD_SITE_PATH" != "$CADDY_SITE_PATH" ]] && run_root test -e "$CADDY_OLD_SITE_PATH"; then
    caddy_backup_site "$CADDY_OLD_SITE_PATH"
    CADDY_CHANGES_APPLIED=1
    run_root rm -f -- "$CADDY_OLD_SITE_PATH"
    say "Удалён прежний сайт-файл этого экземпляра: ${CADDY_OLD_SITE_PATH}"
  fi

  caddy_write_site
  caddy_ensure_import

  after_snapshot=$(mktemp)
  TEMP_FILES+=("$after_snapshot")
  caddy_snapshot "$after_snapshot"

  if ! caddy_verify_untouched "$before_snapshot" "$after_snapshot"; then
    caddy_rollback
    die "Изменения Caddy отменены: изменились посторонние файлы конфигурации."
  fi
  if (( CADDY_IMPORT_ADDED == 1 )) && ! caddy_verify_main_only_import; then
    caddy_rollback
    die "Изменения Caddy отменены: основной Caddyfile изменён не только добавлением import."
  fi

  if ! caddy_validate; then
    say_err "caddy validate завершился с ошибкой:"
    printf '%s\n' "$CADDY_VALIDATE_OUTPUT" >&2
    caddy_rollback
    die "Изменения Caddy отменены, reload не выполнялся. Исправьте конфигурацию Caddy и запустите установщик снова."
  fi

  CADDY_CONFIG_VALID=1
  if caddy_reload; then
    CADDY_CHANGES_APPLIED=0
  else
    # Конфигурация записана и прошла caddy validate: откат не выполняем,
    # чтобы не удалить уже применённый валидный конфиг из-за недоступного reload.
    say "Внимание: Caddy не перезагружен, но валидная конфигурация оставлена на диске. Перезагрузите Caddy вручную: ${SUDO_PREFIX}caddy reload --config ${CADDYFILE}"
  fi
  caddy_public_checks
}

print_summary() {
  cat <<EOF

Установка завершена.

Игра:              https://${DOMAIN}
TV-режим:          https://${DOMAIN}/room/<КОД>/display
Телефон:           https://${DOMAIN}/room/<КОД>/player
Локальная проверка: http://127.0.0.1:${APP_HOST_PORT}/api/health

Каталог установки: ${INSTALL_DIR}
Compose-проект:    ${COMPOSE_PROJECT_NAME}
Файл окружения:    ${env_file} (права 600)

Caddy:             сайт-файл ${CADDY_SITE_PATH}
                   основной конфиг ${CADDYFILE} (подключение ${CADDY_SITES_DIR}/*)
HTTPS:             сертификат Let's Encrypt Caddy выдаст автоматически для ${DOMAIN}
Перезагрузка Caddy: ${SUDO_PREFIX}systemctl reload caddy

Логи:        cd ${INSTALL_DIR} && ${SUDO_PREFIX}docker compose logs -f --tail=${LOG_TAIL_LINES}
Перезапуск:  cd ${INSTALL_DIR} && ${SUDO_PREFIX}docker compose restart
Обновление:  запустите установщик снова или выполните
             cd ${INSTALL_DIR} && ${SUDO_PREFIX}git fetch origin && ${SUDO_PREFIX}git checkout ${REPO_REF} && ${SUDO_PREFIX}docker compose up -d --build

Данные комнат лежат в томе room-data и сохраняются при обновлении.
Не используйте docker compose down -v: это удалит базу комнат.
EOF
}

main() {
  detect_tty
  say "Установка Guess the Melody"
  setup_root
  check_os
  detect_port_check_tool || true
  ensure_base_tools
  ensure_docker
  ensure_caddy
  prepare_defaults
  if (( HAS_TTY == 1 )); then
    collect_interactive
  else
    collect_noninteractive
  fi
  fetch_code
  write_env_file
  start_app
  wait_for_health
  caddy_setup
  print_summary
}

main "$@"
