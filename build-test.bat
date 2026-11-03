@echo off
REM ARMOR-SERVER non-mutating build-test launcher. GPL-3.0-or-later.
set "ARMOR_COMMON_ROOT=%~dp0..\ARMOR-COMMON"
if defined ARMOR_COMMON_DIR set "ARMOR_COMMON_ROOT=%ARMOR_COMMON_DIR%"
call "%ARMOR_COMMON_ROOT%\scripts\armor-project.bat" build-test "%~dp0."
exit /b %ERRORLEVEL%
