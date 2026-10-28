# Copyright (c) Microsoft. All rights reserved.

#Requires -Version 7.4
<#
.SYNOPSIS
Requires an unsuppressed BA2014/CFG pass for the exact DLL with matching symbols.
.DESCRIPTION
Reads a full BinSkim 4.4.9 SARIF report produced with --hashes true and
--trace PdbLoad. Does not run a scanner, download tools, or modify inputs.
#>
param(
    [Parameter(Mandatory)] [string] $Dll,
    [Parameter(Mandatory)] [string] $Report
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$dllPath = (Resolve-Path -LiteralPath $Dll).ProviderPath
$pdbPath = [IO.Path]::ChangeExtension($dllPath, '.pdb')
foreach ($artifact in @($dllPath, $pdbPath)) {
    if (-not [IO.File]::Exists($artifact) -or
        ([IO.FileInfo] $artifact).Length -eq 0 -or
        ([IO.FileInfo] $artifact).Length -gt 64MB) {
        throw 'The DLL and adjacent matching PDB must both be present, nonempty and at most 64 MiB.'
    }
}
$reportPath = (Resolve-Path -LiteralPath $Report).ProviderPath
if (([IO.FileInfo] $reportPath).Length -gt 64MB) {
    throw 'BinSkim report exceeds 64 MiB.'
}
$sarif = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json -AsHashtable -Depth 64
if ($sarif.version -ne '2.1.0' -or @($sarif.runs).Count -ne 1) {
    throw 'Expected one SARIF 2.1.0 analysis run.'
}
$run = $sarif.runs[0]
if (@($run.invocations).Count -ne 1 -or $run.invocations[0].executionSuccessful -ne $true) {
    throw 'BinSkim analysis did not complete successfully.'
}
$dllHash = (Get-FileHash -LiteralPath $dllPath -Algorithm SHA256).Hash
if (@($run.artifacts).Count -ne 1 -or $run.artifacts[0].hashes['sha-256'] -ne $dllHash) {
    throw 'BinSkim artifact hash does not match the DLL.'
}
$scannedUri = [uri] $run.artifacts[0].location.uri
if (-not $scannedUri.IsFile -or $scannedUri.LocalPath -ne $dllPath) {
    throw 'BinSkim artifact path does not match the DLL.'
}
$invocation = $run.invocations[0]
$notifications = @($invocation['toolExecutionNotifications']) + @($invocation['toolConfigurationNotifications'])
if (@($notifications | Where-Object { $_ -and $_.level -eq 'error' }).Count -ne 0) {
    throw 'BinSkim reported an analysis or configuration error.'
}
$pdbLoads = @($notifications | Where-Object {
    $_ -and $_['descriptor'] -and $_.descriptor['id'] -eq 'TRC001.PdbLoad' -and
    $_.locations[0].physicalLocation.artifactLocation.uri -eq $scannedUri.AbsoluteUri -and
    $_.message.text.Contains("The PDB for '$([IO.Path]::GetFileName($dllPath))' was found and loaded.") -and
    $_.message.text.Contains("'$pdbPath'. HResult: S_OK.")
})
if ($pdbLoads.Count -ne 1) {
    throw 'BinSkim did not confirm loading the adjacent matching PDB.'
}
foreach ($ruleId in @('BA2008', 'BA2014')) {
    $results = @($run.results | Where-Object { $_.ruleId -eq $ruleId })
    if ($results.Count -ne 1 -or $results[0]['kind'] -ne 'pass' -or
        $results[0]['level'] -ne 'none' -or
        ($results[0].Contains('suppressions') -and @($results[0]['suppressions']).Count -ne 0) -or
        $results[0].locations[0].physicalLocation.artifactLocation.uri -ne $scannedUri.AbsoluteUri) {
        throw "Expected exactly one unsuppressed $ruleId pass for the DLL."
    }
}
$warnings = @()
foreach ($result in $run.results) {
    $level = $result['level']
    if (-not $level) {
        $rule = @($run.tool.driver.rules | Where-Object { $_.id -eq $result.ruleId })
        if ($rule.Count -ne 1) { throw "Missing rule metadata for $($result.ruleId)." }
        $configuration = $rule[0]['defaultConfiguration']
        $level = if ($configuration) { $configuration['level'] } else { $null }
        if (-not $level) { $level = 'warning' } # SARIF's default result level.
    }
    if ($level -eq 'error') { throw "BinSkim reported $($result.ruleId) as an error." }
    if ($level -eq 'warning') {
        $warnings += $result.ruleId
        Write-Warning "BinSkim $($result.ruleId) remains a warning; inspect the full report."
    }
}
[pscustomobject] @{
    dllSha256 = $dllHash
    pdbSha256 = (Get-FileHash -LiteralPath $pdbPath -Algorithm SHA256).Hash
    matchingPdbLoaded = $true
    BA2008 = 'pass'
    BA2014 = 'pass'
    warnings = $warnings
} | ConvertTo-Json -Compress
