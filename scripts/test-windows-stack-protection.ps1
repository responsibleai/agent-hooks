# Copyright (c) Microsoft. All rights reserved.

#Requires -Version 7.4
<#
.SYNOPSIS
Checks a real matching-PDB scan and exercises fail-closed SARIF validation.
#>
param(
    [Parameter(Mandatory)] [string] $Dll,
    [Parameter(Mandatory)] [string] $Report
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$checker = Join-Path $PSScriptRoot 'check-windows-stack-protection.ps1'
$Dll = (Resolve-Path -LiteralPath $Dll).ProviderPath
$Report = (Resolve-Path -LiteralPath $Report).ProviderPath
& $checker -Dll $Dll -Report $Report
$original = Get-Content -LiteralPath $Report -Raw
$checks = 1

function Assert-Rejected {
    param([scriptblock] $Check, [string] $Name, [string] $Reason)

    $rejected = $false
    try { & $Check | Out-Null }
    catch {
        if ($_.Exception.Message -notmatch $Reason) { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw "Stack-protection gate accepted negative fixture: $Name" }
    Write-Host "Rejected $Name"
}

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('agent-hooks-stack-' + [Guid]::NewGuid())
$null = [IO.Directory]::CreateDirectory($temporary)
try {
    $cases = @(
        @{ Name = 'unprotected standard-library functions'; Reason = 'BA2014'; Change = {
            param($run)
            $result = $run.results | Where-Object { $_.ruleId -eq 'BA2014' }
            $result.kind = 'fail'; $result.level = 'error'
        } },
        @{ Name = 'missing BA2014 result'; Reason = 'BA2014'; Change = {
            param($run)
            $run.results = @($run.results | Where-Object { $_.ruleId -ne 'BA2014' })
        } },
        @{ Name = 'inapplicable stack-protection check'; Reason = 'BA2014'; Change = {
            param($run)
            ($run.results | Where-Object { $_.ruleId -eq 'BA2014' }).kind = 'notApplicable'
        } },
        @{ Name = 'suppressed stack-protection result'; Reason = 'BA2014'; Change = {
            param($run)
            ($run.results | Where-Object { $_.ruleId -eq 'BA2014' }).suppressions = @(@{ kind = 'external' })
        } },
        @{ Name = 'duplicate stack-protection result'; Reason = 'BA2014'; Change = {
            param($run)
            $run.results += @($run.results | Where-Object { $_.ruleId -eq 'BA2014' })
        } },
        @{ Name = 'CFG regression'; Reason = 'BA2008'; Change = {
            param($run)
            ($run.results | Where-Object { $_.ruleId -eq 'BA2008' }).kind = 'fail'
        } },
        @{ Name = 'incomplete analysis'; Reason = 'did not complete'; Change = {
            param($run)
            $run.invocations[0].executionSuccessful = $false
        } },
        @{ Name = 'scanner execution error'; Reason = 'analysis or configuration error'; Change = {
            param($run)
            $run.invocations[0].toolExecutionNotifications = @(@{ level = 'error' })
        } },
        @{ Name = 'missing PDB evidence'; Reason = 'matching PDB'; Change = {
            param($run)
            $run.invocations[0].toolConfigurationNotifications = @()
        } },
        @{ Name = 'failed PDB load'; Reason = 'matching PDB'; Change = {
            param($run)
            foreach ($notification in $run.invocations[0].toolConfigurationNotifications) {
                if ($notification.descriptor.id -eq 'TRC001.PdbLoad') {
                    $notification.message.text = 'PDB not found.'
                }
            }
        } },
        @{ Name = 'stale DLL hash'; Reason = 'artifact hash'; Change = {
            param($run)
            $run.artifacts[0].hashes['sha-256'] = '0' * 64
        } },
        @{ Name = 'different scanned DLL'; Reason = 'artifact path'; Change = {
            param($run)
            $run.artifacts[0].location.uri += '.other'
        } },
        @{ Name = 'multiple scanned artifacts'; Reason = 'artifact hash'; Change = {
            param($run)
            $run.artifacts += @($run.artifacts[0])
        } },
        @{ Name = 'another binary-analysis error'; Reason = 'as an error'; Change = {
            param($run)
            $run.results += @(@{ ruleId = 'BA9999'; level = 'error' })
        } }
    )
    $fixture = Join-Path $temporary 'negative.sarif'
    foreach ($case in $cases) {
        $copy = $original | ConvertFrom-Json -AsHashtable -Depth 64
        & $case.Change $copy.runs[0]
        $copy | ConvertTo-Json -Depth 64 | Set-Content -LiteralPath $fixture
        Assert-Rejected -Name $case.Name -Reason $case.Reason -Check {
            & $checker -Dll $Dll -Report $fixture
        }
        $checks++
    }
    $noPdb = Join-Path $temporary 'agent_hooks_ffi.dll'
    [IO.File]::Copy($Dll, $noPdb)
    Assert-Rejected -Name 'missing adjacent symbols' -Reason 'matching PDB must both be present' -Check {
        & $checker -Dll $noPdb -Report $Report
    }
    $checks++
}
finally {
    [IO.Directory]::Delete($temporary, $true)
}
Write-Host "Stack-protection gate: $checks checks passed."
