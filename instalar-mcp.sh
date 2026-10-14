#!/usr/bin/env bash
# Instala los MCP Context7, Playwright, Firecrawl y Composio para todos tus proyectos
# (scope "user"). Se puede correr varias veces sin duplicar nada.
# Uso: bash instalar-mcp.sh

OK="\033[32m✓\033[0m"
FAIL="\033[31m✗\033[0m"

echo "== Revisando requisitos =="

if ! command -v node >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
  echo -e "$FAIL Node.js no está instalado. Descargalo en https://nodejs.org y volvé a correr este script."
  exit 1
fi
echo -e "$OK Node.js $(node --version)"

if ! command -v claude >/dev/null 2>&1; then
  echo -e "$FAIL Claude Code no está instalado. Instalalo con: npm install -g @anthropic-ai/claude-code"
  exit 1
fi
echo -e "$OK Claude Code $(claude --version 2>/dev/null)"

instalado() {
  claude mcp get "$1" >/dev/null 2>&1
}

agregar() {
  # agregar <nombre> <args de claude mcp add...>
  local nombre="$1"; shift
  if instalado "$nombre"; then
    echo -e "$OK $nombre ya estaba instalado, lo dejo como está"
    return
  fi
  if claude mcp add --scope user "$nombre" "$@"; then
    echo -e "$OK $nombre instalado"
  else
    echo -e "$FAIL No se pudo instalar $nombre"
  fi
}

echo
echo "== Instalando MCP =="

agregar context7 -- npx -y @upstash/context7-mcp
agregar playwright -- npx -y @playwright/mcp@latest

if instalado firecrawl; then
  echo -e "$OK firecrawl ya estaba instalado, lo dejo como está"
else
  read -r -p "Clave de Firecrawl (Enter para saltear): " FIRECRAWL_KEY
  if [ -z "$FIRECRAWL_KEY" ]; then
    echo "-  firecrawl salteado (volvé a correr el script cuando tengas la clave)"
  else
    agregar firecrawl -e "FIRECRAWL_API_KEY=$FIRECRAWL_KEY" -- npx -y firecrawl-mcp
  fi
fi

if instalado composio; then
  echo -e "$OK composio ya estaba instalado, lo dejo como está"
else
  echo "Composio: entrá a https://composio.dev, creá tu servidor MCP y copiá la URL que te da."
  read -r -p "URL de Composio (Enter para saltear): " COMPOSIO_URL
  if [ -z "$COMPOSIO_URL" ]; then
    echo "-  composio salteado (volvé a correr el script cuando tengas la URL)"
  else
    agregar composio --transport http "$COMPOSIO_URL"
  fi
fi

echo
echo "== Lo que quedó instalado =="
claude mcp list
