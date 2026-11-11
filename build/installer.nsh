; -*- coding: utf-8 -*-
; 原神跟跑助手 —— NSIS 自定义安装页
;
; 由 electron-builder 的 nsis.include 注入到生成脚本的【头部】，
; 所以这里定义的 customWelcomePage / customPageAfterChangeDir / customFinishPage
; 能被 assistedInstaller.nsh 里的 !ifmacrodef 检测到。
; 许可页由 nsis.license 自动生成 licensePage 宏，这里【不要】重复定义。
;
; ⚠ 本文件必须是 UTF-8 BOM：NSIS 3 Unicode 安装器没有 BOM 时中文会乱码。
;    用 Edit 改完记得检查前三字节仍是 EF BB BF。

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; 自定义页的选项，customInstall 里读取并用它们写文件 / 注册表。
; 同样只在安装器脚本里声明：卸载器用不到，NSIS 会报 6001「变量未引用」并被 /WX 判失败。
!ifndef BUILD_UNINSTALLER
Var /GLOBAL grbDlg
Var /GLOBAL grbChkMigrate
Var /GLOBAL grbChkLogin
Var /GLOBAL grbChkAutoRun
Var /GLOBAL grbDirEdit
Var /GLOBAL grbBrowseBtn
Var /GLOBAL grbMigrateDir
Var /GLOBAL grbWithLogin
Var /GLOBAL grbAutoRun
!endif

; ---------------------------------------------------------------- 欢迎页
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎安装 原神跟跑助手"
  !define MUI_WELCOMEPAGE_TEXT "本向导会把原神跟跑助手安装到你的电脑。$\r$\n$\r$\n它会读取 B 站攻略视频里的小地图，识别角色行进方向（红箭头）与镜头朝向（绿弧），再用置顶浮窗提示你。$\r$\n$\r$\n程序需要管理员权限：Windows 的 UIPI 会挡住普通进程在游戏窗口前的全局热键。$\r$\n$\r$\n点击「下一步」继续。"
  ; MUI2 展开页面宏时自己会 !undef 这些 define；这里再 undef 会触发
  ; 6155 警告，而 electron-builder 的 /WX 会把警告当错误 ⇒ 不要重复清理。
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ------------------------------------------------------- 初始化页面变量
!macro customInit
  StrCpy $grbMigrateDir ""
  StrCpy $grbWithLogin "0"
  StrCpy $grbAutoRun "0"
!macroend

; ------------------------------------------- 目录页之后：安装选项自定义页
!macro customPageAfterChangeDir
  Page custom grbOptionsPageCreate grbOptionsPageLeave
!macroend

; 卸载器编译时用不到这些页面函数，NSIS 会报 6010「install function not referenced」，
; electron-builder 又用 /WX 把警告当错误 ⇒ 整包失败。所以只在安装器脚本里定义。
!ifndef BUILD_UNINSTALLER
Function grbOptionsPageCreate
  nsDialogs::Create 1018
  Pop $grbDlg
  ${If} $grbDlg == error
    Abort
  ${EndIf}

  ${NSD_CreateGroupBox} 0 0 100% 96u "从旧绿色版迁移数据（可选）"
  Pop $0

  ${NSD_CreateCheckBox} 8u 14u 94% 10u "迁移设置与 ROI 标定（settings.json）"
  Pop $grbChkMigrate

  ${NSD_CreateLabel} 8u 28u 94% 9u "旧绿色版文件夹（里面有 data 子目录）："
  Pop $0

  ${NSD_CreateDirRequest} 8u 38u 72% 12u ""
  Pop $grbDirEdit

  ${NSD_CreateBrowseButton} 82u 38u 16% 12u "浏览..."
  Pop $grbBrowseBtn
  ${NSD_OnClick} $grbBrowseBtn grbOnBrowse

  ${NSD_CreateCheckBox} 8u 54u 94% 10u "同时迁移 B 站登录态（仅本机复制，不会写进安装包）"
  Pop $grbChkLogin

  ${NSD_CreateLabel} 8u 70u 94% 18u "留空即可全新安装；旧文件夹不会被改动。迁移只做一次。"
  Pop $0

  ${NSD_CreateCheckBox} 0 102u 100% 10u "开机自动启动启动器"
  Pop $grbChkAutoRun

  ${NSD_CreateLabel} 0 116u 100% 18u "安装版的设置与标定保存在 %APPDATA%\原神跟跑助手\，卸载时默认保留，重装可直接续上。"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function grbOnBrowse
  Pop $R0
  nsDialogs::SelectFolderDialog "选择旧绿色版文件夹（里面有 data 子目录）" "$DOCUMENTS"
  Pop $R1
  ${If} $R1 != "error"
    ${NSD_SetText} $grbDirEdit "$R1"
  ${EndIf}
FunctionEnd

Function grbOptionsPageLeave
  ${NSD_GetState} $grbChkMigrate $0
  ${If} $0 == 1
    ${NSD_GetText} $grbDirEdit $grbMigrateDir
    ${If} $grbMigrateDir == ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "已勾选迁移，请先选择旧绿色版文件夹，或取消勾选。"
      Abort
    ${EndIf}
  ${Else}
    StrCpy $grbMigrateDir ""
  ${EndIf}

  ${NSD_GetState} $grbChkLogin $0
  ${If} $0 == 1
    StrCpy $grbWithLogin "1"
  ${Else}
    StrCpy $grbWithLogin "0"
  ${EndIf}

  ${NSD_GetState} $grbChkAutoRun $0
  ${If} $0 == 1
    StrCpy $grbAutoRun "1"
  ${Else}
    StrCpy $grbAutoRun "0"
  ${EndIf}
FunctionEnd
!endif ; !BUILD_UNINSTALLER

; --------------------------------------------------------------- 安装时
!macro customInstall
  ; installed.flag 是 P0 数据分流的唯一依据：
  ; 有它 → userData 走 %APPDATA%，否则会写 Program Files 直接崩。
  ClearErrors
  FileOpen $0 "$INSTDIR\installed.flag" w
  ${If} $0 != ""
    FileWrite $0 "installed$\r$\n"
    FileClose $0
  ${EndIf}
  ClearErrors

  ; 安装页填的旧绿色版目录 → 主进程首次启动时做一次性迁移
  ${If} $grbMigrateDir != ""
    ClearErrors
    FileOpen $0 "$INSTDIR\migrate-from.txt" w
    ${If} $0 != ""
      FileWrite $0 "$grbMigrateDir$\r$\n"
      ${If} $grbWithLogin == "1"
        FileWrite $0 "includeLogin=1$\r$\n"
      ${EndIf}
      FileClose $0
    ${EndIf}
    ClearErrors
  ${EndIf}

  ${If} $grbAutoRun == "1"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "GenshinRouteBuddy" '"$appExe"'
  ${Else}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "GenshinRouteBuddy"
  ${EndIf}
!macroend

; --------------------------------------------------------------- 卸载时
; 只清理安装页自己写的东西；%APPDATA% 里的设置 / 标定 / 登录态一律保留
; （package.json 里 deleteAppDataOnUninstall: false，卸载器也不会删 userData）。
!macro customUnInstall
  Delete "$INSTDIR\installed.flag"
  Delete "$INSTDIR\migrate-from.txt"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "GenshinRouteBuddy"
!macroend

; --------------------------------------------------------------- 完成页
; 函数定义在宏体里而不是文件头：展开点在 installer.nsi 之后，
; 那时 $appExe / $launchLink 已经 Var 声明过，编译不会报未知变量。
!macro customFinishPage
  Function grbStartApp
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  FunctionEnd
  !define MUI_FINISHPAGE_TITLE "安装完成"
  !define MUI_FINISHPAGE_TEXT "原神跟跑助手已就绪。$\r$\n$\r$\n设置与 ROI 标定保存在 %APPDATA%\原神跟跑助手\，卸载不会删除；绿色版的数据在程序目录 data\ 里，两者不自动同步。$\r$\n$\r$\n首次运行会弹一次 UAC，这是全局热键生效所必需的。"
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "立即启动 原神跟跑助手"
  !define MUI_FINISHPAGE_RUN_FUNCTION "grbStartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend
