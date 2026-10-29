# Instala los MCP Context7, Playwright, Firecrawl y Composio para todos tus proyectos
# (scope "user"). Se puede correr varias veces sin duplicar nada.
# Uso: clic derecho -> "Ejecutar con PowerShell"

$ErrorActionPreference = "Continue"

function Ok($msg)   { Write-Host "[OK] $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "[X]  $msg" -ForegroundColor Red }

function Terminar($codigo) {
    Read-Host "Presioná Enter para cerrar"
    exit $codigo
}

Write-Host "== Revisando requisitos =="

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npx -ErrorAction SilentlyContinue)) {
    Fail "Node.js no está instalado. Descargalo en https://nodejs.org y volvé a correr este script."
    Terminar 1
}
Ok "Node.js $(node --version)"

# El instalador nativo deja claude en .local\bin y no siempre lo suma al PATH
$localBin = Join-Path $env:USERPROFILE ".local\bin"
if (-not (Get-Command claude -ErrorAction SilentlyContinue) -and (Test-Path (Join-Path $localBin "claude.exe"))) {
    $env:Path += ";$localBin"
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Fail "Claude Code no está instalado. Instalalo con: npm install -g @anthropic-ai/claude-code"
    Terminar 1
}
Ok "Claude Code $(claude --version 2>$null)"

function Instalado($nombre) {
    claude mcp get $nombre *> $null
    return ($LASTEXITCODE -eq 0)
}

function Agregar($nombre, [string[]]$extra) {
    if (Instalado $nombre) {
        Ok "$nombre ya estaba instalado, lo dejo como está"
        return
    }
    claude mcp add --scope user $nombre @extra
    if ($LASTEXITCODE -eq 0) { Ok "$nombre instalado" }
    else { Fail "No se pudo instalar $nombre" }
}

Write-Host ""
Write-Host "== Instalando MCP =="

# En Windows, npx es un .cmd, así que se invoca con cmd /c
Agregar "context7"   @("--", "cmd", "/c", "npx", "-y", "@upstash/context7-mcp")
Agregar "playwright" @("--", "cmd", "/c", "npx", "-y", "@playwright/mcp@latest")

if (Instalado "firecrawl") {
    Ok "firecrawl ya estaba instalado, lo dejo como está"
} else {
    $clave = Read-Host "Clave de Firecrawl (Enter para saltear)"
    if ([string]::IsNullOrWhiteSpace($clave)) {
        Write-Host "-    firecrawl salteado (volvé a correr el script cuando tengas la clave)"
    } else {
        Agregar "firecrawl" @("-e", "FIRECRAWL_API_KEY=$clave", "--", "cmd", "/c", "npx", "-y", "firecrawl-mcp")
    }
}

if (Instalado "composio") {
    Ok "composio ya estaba instalado, lo dejo como está"
} else {
    Write-Host "Composio: entrá a https://composio.dev, creá tu servidor MCP y copiá la URL que te da."
    $url = Read-Host "URL de Composio (Enter para saltear)"
    if ([string]::IsNullOrWhiteSpace($url)) {
        Write-Host "-    composio salteado (volvé a correr el script cuando tengas la URL)"
    } else {
        Agregar "composio" @("--transport", "http", $url)
    }
}

Write-Host ""
Write-Host "== Lo que quedó instalado =="
claude mcp list

Write-Host ""
Terminar 0
