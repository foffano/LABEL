#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$wrapper = Join-Path $root 'tools/ToffaPrintBridge.exe'
if (!(Test-Path "$root/config.json")) { throw 'Execute setup.py primeiro.' }
if (!(Test-Path $wrapper)) { throw 'Baixe o WinSW conforme README.md.' }
if (Get-Service ToffaPrintBridge -ErrorAction SilentlyContinue) { throw 'O serviço já existe.' }
# Código e configuração de um serviço não devem ser alteráveis por usuários comuns.
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $root /inheritance:r /grant:r "*${ownerSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'
if ($LASTEXITCODE -ne 0) { throw 'Falha ao proteger diretório.' }
& $wrapper install
if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar serviço.' }
& $wrapper start
if ($LASTEXITCODE -ne 0) { throw 'Falha ao iniciar serviço.' }
Get-Service ToffaPrintBridge
