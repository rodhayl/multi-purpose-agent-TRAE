@echo off
setlocal
pushd "%~dp0"
for /f "delims=" %%i in ('node -p "require('./package.json').name"') do set EXTENSION_NAME=%%i
for /f "delims=" %%i in ('node -p "require('./package.json').version"') do set EXTENSION_VERSION=%%i
set VSIX_FILE=%EXTENSION_NAME%-%EXTENSION_VERSION%.vsix

echo Building Multi Purpose Agent for TRAE %EXTENSION_VERSION%...

echo Installing dependencies...
call npm.cmd install
if %errorlevel% neq 0 (popd & exit /b %errorlevel%)

echo Compiling extension...
call npm.cmd run compile
if %errorlevel% neq 0 (popd & exit /b %errorlevel%)

echo Packaging VSIX...
set GIT_PAGER=
set PAGER=
set LESS=
if exist "%VSIX_FILE%" del /f /q "%VSIX_FILE%"
call npx.cmd @vscode/vsce package --no-git-tag-version --out "%VSIX_FILE%"
if %errorlevel% neq 0 (popd & exit /b %errorlevel%)

echo Build complete: %VSIX_FILE%
popd
