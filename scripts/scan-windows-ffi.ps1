# Copyright (c) Microsoft. All rights reserved.

#Requires -Version 7.4
<#
.SYNOPSIS
Scans the Windows FFI with its matching PDB and checks stack protection.
#>
param(
    [Parameter(Mandatory)] [string] $NativeDirectory,
    [Parameter(Mandatory)] [string] $TemporaryDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$release = (Resolve-Path -LiteralPath $NativeDirectory).ProviderPath
$archive = Join-Path $TemporaryDirectory 'binskim-4.4.9.nupkg'
$tools = Join-Path $TemporaryDirectory 'binskim-4.4.9'
Invoke-WebRequest https://www.nuget.org/api/v2/package/Microsoft.CodeAnalysis.BinSkim/4.4.9 `
    -OutFile $archive -TimeoutSec 120
$expected = '0700BAD9B472D86503A74E3E839D2BC8C32B8EDE7302D7167A42E4969C88A300'
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) {
    throw 'BinSkim package hash does not match the pinned analyzer.'
}
dotnet nuget verify $archive --all
if ($LASTEXITCODE -ne 0) { throw 'BinSkim package signature verification failed.' }
[IO.Compression.ZipFile]::ExtractToDirectory($archive, $tools)
$scanner = Join-Path $tools 'tools/net9.0/win-x64/BinSkim.exe'
$dll = Join-Path $release 'agent_hooks_ffi.dll'
$report = Join-Path $TemporaryDirectory 'windows-ffi-binskim.sarif'
$log = Join-Path $TemporaryDirectory 'windows-ffi-binskim.log'
& $scanner analyze $dll --output $report --disable-telemetry true `
    --sympath $release --local-symbol-directories $release --threads 1 `
    --timeout-in-seconds 120 --max-file-size-in-kb 65536 --hashes true `
    --kind 'Fail;Pass;Review;NotApplicable;Informational' --level 'Error;Warning;Note' `
    --trace PdbLoad *> $log
if ($LASTEXITCODE -ne 0) { throw "BinSkim execution failed; see $log." }
& (Join-Path $PSScriptRoot 'test-windows-stack-protection.ps1') -Dll $dll -Report $report
