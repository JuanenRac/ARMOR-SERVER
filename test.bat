@echo off
REM ARMOR-SERVER test launcher (tests and checks, never changes the version). GPL-3.0-or-later.
call "%~dp0..\ARMOR-COMMON\scripts\armor-project.bat" test "%~dp0."
exit /b %ERRORLEVEL%
