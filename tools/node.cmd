@echo off
REM Bundled Node shim. `node` is not on PATH on this machine.
REM Keep this file pure ASCII: cmd.exe reads .cmd as ANSI/GBK, so UTF-8
REM punctuation (em dash, curly quotes) corrupts the batch parse.
setlocal
set "NODE_EXE=C:\Users\sun\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
"%NODE_EXE%" %*
exit /b %errorlevel%
