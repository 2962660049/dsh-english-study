@echo off
REM Bundled pnpm shim. `pnpm` is not on PATH on this machine.
REM Keep this file pure ASCII: cmd.exe reads .cmd as ANSI/GBK, so UTF-8
REM punctuation (em dash, curly quotes) corrupts the batch parse.
setlocal
set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
set "PNPM_MJS=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
"%NODE_EXE%" "%PNPM_MJS%" %*
exit /b %errorlevel%
