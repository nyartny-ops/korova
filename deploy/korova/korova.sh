#!/usr/bin/env bash
# Korova VPN: installs the package GitHub Actions built; nothing is compiled on the server.
#   korova install          # main server: panel, bot, subscriptions
#   korova install node     # extra server for VPN traffic
#   korova update           # download the latest build and restart
#   korova token            # new one-line key to connect this node
#   korova info             # panel address and login
set -euo pipefail
trap 'rc=$?; [ $rc -ne 0 ] && printf "\n\033[31m✗ Остановилось на строке %s (код %s). Пришли этот вывод.\033[0m\n" "$LINENO" "$rc" >&2' EXIT

REPO="${KOROVA_REPO:-__KOROVA_REPO__}"
CMD="${1:-install}"
ROLE="${2:-master}"
APP=/usr/local/x-ui
DB=/etc/x-ui
ENVF=/etc/default/x-ui
CREDS=$DB/.korova-credentials
TMP=/var/tmp/korova-pkg

say() { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die() { trap - EXIT; printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запусти от root."
[[ "$REPO" == */* && "$REPO" != *__* ]] || die "Не знаю, откуда качать. Запусти так: KOROVA_REPO=твой_ник/korova bash korova.sh $CMD"
case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "Архитектура $(uname -m) не поддерживается" ;;
esac
RELEASE="https://github.com/$REPO/releases/download/korova-latest"

getenv() { [ -f "$ENVF" ] && grep -E "^$1=" "$ENVF" | tail -1 | cut -d= -f2- || true; }
setenv() {
  touch "$ENVF" && chmod 600 "$ENVF"
  if grep -qE "^$1=" "$ENVF"; then sed -i "s|^$1=.*|$1=$2|" "$ENVF"; else echo "$1=$2" >> "$ENVF"; fi
}
xui() { (cd "$APP" && set -a && . "$ENVF" && set +a && ./x-ui "$@"); }
# tr|head ends with SIGPIPE, which pipefail + set -e would turn into a silent exit.
rnd() { LC_ALL=C tr -dc "$1" </dev/urandom 2>/dev/null | head -c "$2" || true; }

remove_old_attempts() {
  if command -v docker >/dev/null 2>&1; then
    docker rm -f korova korova-caddy >/dev/null 2>&1 || true
    docker rmi korova:latest >/dev/null 2>&1 || true
    docker volume rm korova-gocache >/dev/null 2>&1 || true
    docker builder prune -af >/dev/null 2>&1 || true
  fi
  for f in /korova-swap /korova-build-swap; do
    swapoff "$f" 2>/dev/null || true
    rm -f "$f"
  done
  sed -i '/korova-swap/d' /etc/fstab
  rm -rf /var/tmp/korova-build /opt/korova/frontend/node_modules
}

download() {
  say "Скачиваю Korova с GitHub ($REPO)"
  command -v curl >/dev/null && command -v tar >/dev/null || { apt-get update -qq && apt-get install -y -qq curl tar >/dev/null; }
  rm -rf "$TMP" && mkdir -p "$TMP"
  curl -fL --retry 3 --progress-bar -o "$TMP/pkg.tar.gz" "$RELEASE/korova-linux-$ARCH.tar.gz" \
    || die "Не скачалось. Проверь, что репозиторий публичный и сборка на GitHub (вкладка Actions) прошла успешно."
  tar -xzf "$TMP/pkg.tar.gz" -C "$TMP"
  ok "Сборка $(cat "$TMP/x-ui/KOROVA_VERSION" 2>/dev/null || echo '?')"
}

install_files() {
  say "Устанавливаю"
  systemctl stop x-ui 2>/dev/null || true
  mkdir -p "$APP/bin" "$APP/internal/web" "$DB" /var/log/x-ui
  install -m 755 "$TMP/x-ui/x-ui" "$APP/x-ui"
  cp -f "$TMP"/x-ui/bin/* "$APP/bin/"
  rm -rf "$APP/internal/web/translation" && cp -r "$TMP/x-ui/internal/web/translation" "$APP/internal/web/"
  cp "$TMP/x-ui/x-ui.service" /etc/systemd/system/x-ui.service
  cp "$TMP/x-ui/KOROVA_VERSION" "$APP/" 2>/dev/null || true
  touch "$ENVF" && chmod 600 "$ENVF"
  systemctl daemon-reload
  systemctl enable x-ui >/dev/null 2>&1
  # Keep this script as the `korova` command for updates.
  curl -fsSL "$RELEASE/korova.sh" -o /usr/local/bin/korova 2>/dev/null && chmod +x /usr/local/bin/korova || true
  rm -rf "$TMP"
  ok "Панель в $APP, база в $DB"
}

ask_master() {
  say "Настройка основного сервера"
  local panel sub token admins x busy
  panel=$(getenv KOROVA_PANEL_DOMAIN); panel=${panel:-panel.korova.pro}
  sub=$(getenv KOROVA_SUB_DOMAIN); sub=${sub:-sub.korova.pro}
  admins=$(getenv KOROVA_ADMINS); admins=${admins:-TheArtemy}
  read -rp "  Домен панели [$panel]: " x; panel=${x:-$panel}
  read -rp "  Домен подписки [$sub]: " x; sub=${x:-$sub}
  if [ -z "$(getenv KOROVA_BOT_TOKEN)" ]; then
    read -rsp "  Токен бота от @BotFather (можно пусто, вставишь в панели): " token; echo
    if [ -n "$token" ]; then setenv KOROVA_BOT_TOKEN "$token"; fi
  fi
  read -rp "  Telegram-админы через запятую, без @ [$admins]: " x; admins=${x:-$admins}
  setenv KOROVA_PANEL_DOMAIN "$panel"
  setenv KOROVA_SUB_DOMAIN "$sub"
  setenv KOROVA_ADMINS "$admins"
  setenv KOROVA_REPO "$REPO"

  busy=$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v caddy || true)
  if [ -n "$busy" ]; then
    echo "$busy" | sed 's/^/    /'
    die "Порт 80 или 443 занят (см. выше). Если это nginx: systemctl disable --now nginx — и запусти снова."
  fi
}

# Older Debian/Ubuntu have no caddy package: take the official static binary.
install_caddy_binary() {
  local ver
  ver=$(curl -fsSL https://api.github.com/repos/caddyserver/caddy/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1)
  [ -n "$ver" ] || die "Не удалось узнать версию Caddy"
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${ver}/caddy_${ver}_linux_${ARCH}.tar.gz" | tar xz -C /usr/bin caddy
  chmod +x /usr/bin/caddy
  id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
  mkdir -p /etc/caddy
  cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
Restart=on-failure
AmbientCapabilities=CAP_NET_BIND_SERVICE
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
}

setup_caddy() {
  say "HTTPS для доменов"
  command -v caddy >/dev/null || apt-get install -y -qq caddy >/dev/null 2>&1 || install_caddy_binary
  local panel sub
  panel=$(getenv KOROVA_PANEL_DOMAIN); sub=$(getenv KOROVA_SUB_DOMAIN)
  cat > /etc/caddy/Caddyfile <<EOF
${panel} {
	encode gzip
	@root path /
	respond @root "Not found" 404
	reverse_proxy 127.0.0.1:2053
}

${sub} {
	encode gzip
	reverse_proxy 127.0.0.1:2096
}
EOF
  systemctl enable caddy >/dev/null 2>&1
  systemctl restart caddy
  ok "Сертификаты для $panel и $sub выпустятся автоматически"
}

first_credentials() {
  [ -f "$CREDS" ] && return 0
  local user pass base
  user="korova$(rnd 'a-z0-9' 4)"
  pass="$(rnd 'A-Za-z0-9' 20)"
  base="/$(rnd 'a-z0-9' 12)/"
  if [ "$ROLE" = master ]; then
    xui setting -username "$user" -password "$pass" -webBasePath "$base" -port 2053 -listenIP 127.0.0.1 >/dev/null
  else
    command -v openssl >/dev/null || apt-get install -y -qq openssl >/dev/null
    mkdir -p /root/cert
    [ -f /root/cert/node.crt ] || openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=korova-node" \
      -keyout /root/cert/node.key -out /root/cert/node.crt >/dev/null 2>&1
    xui setting -username "$user" -password "$pass" -webBasePath "$base" -port 2053 \
      -webCert /root/cert/node.crt -webCertKey /root/cert/node.key >/dev/null
  fi
  printf 'role=%s\nuser=%s\npass=%s\nbase=%s\n' "$ROLE" "$user" "$pass" "$base" > "$CREDS"
  chmod 600 "$CREDS"
}

start() {
  systemctl restart x-ui
  sleep 4
  systemctl is-active --quiet x-ui || { journalctl -u x-ui -n 30 --no-pager; die "Панель не запустилась, лог выше."; }
  ok "Панель запущена"
}

# One line for the main panel: address, port, path, API key and certificate pin.
node_key() {
  local line tok port fp ip name base json
  line=$(xui setting -getApiToken -tokenName korova-master -tokenScope node-admin 2>/dev/null | grep apiToken || true)
  tok=$(echo "${line#*apiToken:}" | tr -d '[:space:]')
  [ -n "$tok" ] || return 0
  port=$(xui setting -show true 2>/dev/null | awk '$1=="port:" {print $2; exit}')
  base=$(sed -n 's/^base=//p' "$CREDS" 2>/dev/null)
  fp=$(openssl x509 -in /root/cert/node.crt -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2 | tr -d ':')
  ip=$(curl -fsS4 --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
  name=$(hostname -s | tr -cd 'A-Za-z0-9-' | cut -c1-24)
  json=$(printf '{"v":1,"n":"%s","a":"%s","p":%s,"b":"%s","t":"%s","f":"%s"}' "${name:-node}" "$ip" "${port:-2053}" "${base:-/}" "$tok" "$fp")
  printf 'korova-node:%s' "$(printf '%s' "$json" | base64 | tr -d '\n')"
}

info() {
  [ -f "$CREDS" ] || die "Korova ещё не установлена."
  # shellcheck disable=SC1090
  . "$CREDS"
  local ip
  ip=$(curl -fsS4 --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
  if [ "$role" = master ]; then
    say "Korova работает"
    echo "  Панель:  https://$(getenv KOROVA_PANEL_DOMAIN)${base}"
    echo "  Логин:   $user"
    echo "  Пароль:  $pass"
    echo
    echo "  Порт 443 занят панелью и подписками: VPN на этом сервере ставь на 8443 или другой порт."
  else
    say "Узел готов"
    if [ -n "${1:-}" ]; then
      echo "  Скопируй ключ целиком и вставь в основной панели: Серверы и каскады → Подключить сервер"
      echo
      printf '\033[1m%s\033[0m\n' "$1"
      echo
      echo "  Сохрани его. Новый ключ выпускает команда korova token, старый при этом перестаёт работать."
    else
      echo "  Ключ для основной панели: korova token"
    fi
  fi
  echo
  echo "  Обновление: korova update"
}

case "$CMD" in
  install)
    [[ "$ROLE" == master || "$ROLE" == node ]] || die "Роль: master или node"
    if [ "$ROLE" = master ]; then ask_master; fi
    remove_old_attempts
    download
    install_files
    if [ "$ROLE" = master ]; then setup_caddy; fi
    fresh=0
    [ -f "$CREDS" ] || fresh=1
    first_credentials
    start
    tok=""
    if [ "$ROLE" = node ] && [ "$fresh" = 1 ]; then tok=$(node_key); fi
    info "$tok"
    ;;
  update)
    [ -f "$APP/x-ui" ] || die "Korova ещё не установлена: korova install"
    cp -a "$DB/x-ui.db" "$DB/x-ui.db.bak-$(date +%Y%m%d-%H%M)" 2>/dev/null || true
    setenv KOROVA_REPO "$REPO"
    ls -1t "$DB"/x-ui.db.bak-* 2>/dev/null | tail -n +4 | xargs -r rm -f
    download
    install_files
    start
    say "Обновлено. Копия базы до обновления: $DB/x-ui.db.bak-*"
    ;;
  token)
    [ -f "$CREDS" ] || die "Korova ещё не установлена."
    tok=$(node_key)
    [ -n "$tok" ] || die "Не удалось выпустить ключ"
    say "Новый ключ узла (старый больше не работает)"
    echo
    printf '\033[1m%s\033[0m\n' "$tok"
    echo
    echo "  Вставь его в основной панели: Серверы и каскады → Подключить сервер"
    ;;
  info)
    info
    ;;
  *)
    die "Команды: install [master|node], update, token, info"
    ;;
esac
