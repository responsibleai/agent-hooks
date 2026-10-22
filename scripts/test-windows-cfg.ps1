# Copyright (c) Microsoft. All rights reserved.

#Requires -Version 7.4
<#
.SYNOPSIS
Exercises the CFG gate using a real release DLL and temporary negative fixtures.
#>
param([Parameter(Mandatory)] [string] $Dll)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$checker = Join-Path $PSScriptRoot 'check-windows-cfg.ps1'
$Dll = (Resolve-Path -LiteralPath $Dll).ProviderPath
& $checker -Dll $Dll
$checks = 1

function Assert-Rejected {
    param([scriptblock] $Check, [string] $Name, [string] $Reason)

    $rejected = $false
    try { & $Check | Out-Null }
    catch {
        if ($_.Exception.Message -notmatch $Reason) { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw "CFG gate accepted negative fixture: $Name" }
    Write-Host "Rejected $Name"
}

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('agent-hooks-cfg-' + [Guid]::NewGuid())
$null = [IO.Directory]::CreateDirectory($temporary)
try {
    [byte[]] $original = [IO.File]::ReadAllBytes($Dll)
    $stream = [IO.MemoryStream]::new($original, $false)
    $reader = [System.Reflection.PortableExecutable.PEReader]::new($stream)
    try {
        $headers = $reader.PEHeaders
        $optionalHeader = [BitConverter]::ToInt32($original, 0x3c) + 24
        $characteristicsOffset = $optionalHeader + 0x46
        $characteristics = [BitConverter]::ToUInt16($original, $characteristicsOffset)
        $configRva = $headers.PEHeader.LoadConfigTableDirectory.RelativeVirtualAddress
        $sections = @($headers.SectionHeaders | Where-Object {
            $configRva -ge $_.VirtualAddress -and
            $configRva -lt $_.VirtualAddress + $_.SizeOfRawData
        })
        if ($sections.Count -ne 1) { throw 'Expected one load-config section.' }
        $configOffset = $sections[0].PointerToRawData + $configRva - $sections[0].VirtualAddress
    }
    finally {
        $reader.Dispose()
        $stream.Dispose()
    }

    # Mutate copies only: none of these fixtures is a build or package output.
    $cases = @(
        @{ Name = 'missing GuardCF'; Offset = $characteristicsOffset; Bytes = [BitConverter]::GetBytes([uint16] ($characteristics -band 0xbfff)); Reason = 'GuardCF' },
        @{ Name = 'missing DynamicBase'; Offset = $characteristicsOffset; Bytes = [BitConverter]::GetBytes([uint16] ($characteristics -band 0xffbf)); Reason = 'DynamicBase' },
        @{ Name = 'missing load config'; Offset = $optionalHeader + 0xc0; Bytes = [byte[]]::new(4); Reason = 'load configuration' },
        @{ Name = 'short load config'; Offset = $configOffset; Bytes = [BitConverter]::GetBytes([uint32] 0x90); Reason = 'metadata' },
        @{ Name = 'missing check pointer'; Offset = $configOffset + 0x70; Bytes = [byte[]]::new(8); Reason = 'metadata' },
        @{ Name = 'missing dispatch pointer'; Offset = $configOffset + 0x78; Bytes = [byte[]]::new(8); Reason = 'metadata' },
        @{ Name = 'missing function table'; Offset = $configOffset + 0x80; Bytes = [byte[]]::new(8); Reason = 'metadata' },
        @{ Name = 'empty function table'; Offset = $configOffset + 0x88; Bytes = [byte[]]::new(8); Reason = 'metadata' },
        @{ Name = 'header flag without CFG metadata'; Offset = $configOffset + 0x90; Bytes = [byte[]]::new(4); Reason = 'metadata' },
        @{ Name = 'invalid table address'; Offset = $configOffset + 0x80; Bytes = [BitConverter]::GetBytes([uint64] 1); Reason = 'bounds' }
    )
    $fixture = Join-Path $temporary 'negative.dll'
    foreach ($case in $cases) {
        [byte[]] $contents = $original.Clone()
        [Array]::Copy($case.Bytes, 0, $contents, $case.Offset, $case.Bytes.Length)
        [IO.File]::WriteAllBytes($fixture, $contents)
        Assert-Rejected -Name $case.Name -Reason $case.Reason -Check { & $checker -Dll $fixture }
        $checks++
    }

    $package = Join-Path $temporary 'fixture.nupkg'
    $archive = [IO.Compression.ZipFile]::Open($package, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $entry = $archive.CreateEntry('runtimes/win-x64/native/agent_hooks_ffi.dll')
        $output = $entry.Open()
        try { $output.Write($original, 0, $original.Length) }
        finally { $output.Dispose() }
    }
    finally { $archive.Dispose() }
    & $checker -Package $package -ExpectedDll $Dll
    $checks++
    Assert-Rejected -Name 'stale package payload' -Reason 'does not match' -Check {
        & $checker -Package $package -ExpectedDll $PSCommandPath
    }
    $checks++

    $emptyPackage = Join-Path $temporary 'missing-native.nupkg'
    $archive = [IO.Compression.ZipFile]::Open($emptyPackage, [IO.Compression.ZipArchiveMode]::Create)
    $archive.Dispose()
    Assert-Rejected -Name 'missing package asset' -Reason 'exactly one' -Check {
        & $checker -Package $emptyPackage -ExpectedDll $Dll
    }
    $checks++
}
finally {
    [IO.Directory]::Delete($temporary, $true)
}
Write-Host "CFG gate: $checks checks passed."
