#!/usr/bin/env bash
# Atualiza o papo-wormhole (git pull + npm install + build) e instala/reinicia o
# serviço systemd. Por padrão usa um serviço de USUÁRIO (~/.config/systemd/user) com
# linger ligado, que sobe no boot sem depender de login e sem sudo.
#
# Uso: scripts/deploy.sh [opções]
#   --system        serviço de sistema (/etc/systemd/system, pede sudo)
#   --unit NOME     nome do unit (padrão: papo-wormhole)
#   --test          roda npm test antes de subir
#   --no-pull       não faz git pull
#   --no-install    não faz npm install
#   --no-build      não faz npm run build
#   --no-service    só atualiza o código, não mexe no systemd
#   -h, --help      esta ajuda
set -euo pipefail

UNIT="papo-wormhole"
SCOPE="user"
DO_PULL=1 DO_INSTALL=1 DO_BUILD=1 DO_SERVICE=1 DO_TEST=0

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33maviso: %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31merro: %s\033[0m\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
	case "$1" in
		--system) SCOPE="system" ;;
		--unit) UNIT="${2:?--unit exige nome}"; shift ;;
		--test) DO_TEST=1 ;;
		--no-pull) DO_PULL=0 ;;
		--no-install) DO_INSTALL=0 ;;
		--no-build) DO_BUILD=0 ;;
		--no-service) DO_SERVICE=0 ;;
		-h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) die "opção desconhecida: $1 (veja --help)" ;;
	esac
	shift
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || die "não consegui entrar em $REPO"

command -v node >/dev/null || die "node não está no PATH"
NODE_BIN="$(command -v node)"
NODE_OK="$("$NODE_BIN" -e 'const [maj,min]=process.versions.node.split(".").map(Number); process.exit(maj>22||(maj===22&&min>=13)?0:1)' && echo ok || true)"
[[ "$NODE_OK" == "ok" ]] || die "node $("$NODE_BIN" -v) não atende engines (>= 22.13)"

# ── 1. repositório ─────────────────────────────────────────
if [[ "$DO_PULL" == 1 ]]; then
	log "git pull"
	git rev-parse --git-dir >/dev/null 2>&1 || die "$REPO não é um repositório git"
	branch="$(git branch --show-current)"
	[[ -n "$branch" ]] || die "branch detached: checkout uma branch antes de puxar"

	if [[ -n "$(git status --porcelain)" ]]; then
		warn "há alterações locais não commitadas; o pull só avança se elas não conflitar"
	fi

	git fetch origin || die "git fetch falhou (rede? credencial?)"
	if ! git merge-base --is-ancestor "origin/$branch" HEAD 2>/dev/null; then
		git pull --ff-only || die "git pull --ff-only falhou: commite (git commit -a) ou guard (git stash) as alterações locais"
		log "atualizado para $(git rev-parse --short HEAD)"
	else
		log "já estava em $(git rev-parse --short HEAD) (origin/$branch)"
	fi
fi

# ── 2. dependências ────────────────────────────────────────
if [[ "$DO_INSTALL" == 1 ]]; then
	log "npm install"
	npm install --no-audit --no-fund
fi

# ── 3. testes (opcional) e build ───────────────────────────
if [[ "$DO_TEST" == 1 ]]; then
	log "npm test"
	npm test
fi

if [[ "$DO_BUILD" == 1 ]]; then
	log "npm run build"
	npm run build
fi

[[ -f dist/index.js ]] || die "dist/index.js não existe: rode sem --no-build"
[[ -f .env ]] || warn ".env não encontrado em $REPO: o bot vai falhar na configuração"

# ── 4. serviço systemd ─────────────────────────────────────
if [[ "$DO_SERVICE" == 0 ]]; then
	log "pronto (systemd não tocado)"
	exit 0
fi

unit_body() {
	cat <<EOF
[Unit]
Description=Papo <-> Discord bridge (papo-wormhole)
Documentation=file://$REPO/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO
ExecStart=$NODE_BIN $REPO/dist/index.js
Environment=WORMHOLE_ENV_FILE=$REPO/.env
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=5
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=$INSTALL_TARGET
EOF
}

if [[ "$SCOPE" == "user" ]]; then
	INSTALL_TARGET="default.target"
	systemctl --user show-environment >/dev/null 2>&1 ||
		die "sem gerenciador systemd de usuário (XDG_RUNTIME_DIR). Rode como o usuário da sessão ou use --system"

	dir="${HOME}/.config/systemd/user"
	mkdir -p "$dir"
	log "instalando serviço de usuário: $dir/$UNIT.service"
	unit_body >"$dir/$UNIT.service"

	systemctl --user daemon-reload
	systemctl --user enable --now "$UNIT"
	systemctl --user restart "$UNIT"

	# linger: sem isso o serviço de usuário só sobe quando o usuário loga
	if loginctl enable-linger "$USER" 2>/dev/null; then
		log "linger ligado: o serviço sobe no boot, sem login"
	else
		warn "não consegui ligar linger (loginctl enable-linger $USER); sem ele o serviço só sobe no login"
	fi

	systemctl --user status "$UNIT" --no-pager | head -12
	log "acompanhar: journalctl --user -u $UNIT -f"
else
	INSTALL_TARGET="multi-user.target"
	command -v sudo >/dev/null || die "sudo não encontrado para --system"
	path="/etc/systemd/system/$UNIT.service"
	log "instalando serviço de sistema: $path"
	unit_body | sudo tee "$path" >/dev/null
	sudo systemctl daemon-reload
	sudo systemctl enable --now "$UNIT"
	sudo systemctl restart "$UNIT"
	sudo systemctl status "$UNIT" --no-pager | head -12
	log "acompanhar: journalctl -u $UNIT -f"
fi

log "deploy concluído"
