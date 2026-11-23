# Copyright (c) Microsoft. All rights reserved.

#Requires -Version 7.4
<#
.SYNOPSIS
Builds the Windows FFI and Rust standard library with stack protection and CFG.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$previousEnvironment = @{
    CARGO_BUILD_JOBS = $env:CARGO_BUILD_JOBS
    RUSTFLAGS = $env:RUSTFLAGS
    CARGO_ENCODED_RUSTFLAGS = $env:CARGO_ENCODED_RUSTFLAGS
}

Push-Location (Join-Path (Split-Path $PSScriptRoot -Parent) 'sdk/rust')
try {
    rustup toolchain install nightly-2026-10-21 --profile minimal --component rust-src --target x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) { throw 'Windows Rust toolchain installation failed.' }
    $env:CARGO_BUILD_JOBS = '2'
    $env:RUSTFLAGS = '-C control-flow-guard=checks -Z stack-protector=strong -D partial-stack-protector'
    $env:CARGO_ENCODED_RUSTFLAGS = $null
    cargo +nightly-2026-10-21 -Z build-std=std,panic_unwind build --locked --release `
        -p agent-hooks-ffi --target x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) { throw 'Protected Windows FFI build failed.' }
}
finally {
    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
    Pop-Location
}
