; -*- coding: utf-8 -*-
; 原神跟跑助手 —— NSIS 自定义安装页 / 卸载页
;
; 由 electron-builder 的 nsis.include 注入到生成脚本的【头部】，
; 所以这里定义的 customWelcomePage / customPageAfterChangeDir / customFinishPage /
; customUnWelcomePage / customUninstallPage 能被 assistedInstaller.nsh 里的
; !ifmacrodef 检测到。许可页由 nsis.license 自动生成 licensePage 宏，这里【不要】重复定义。
;
; ⚠ 本文件必须是 UTF-8 BOM：NSIS 3 Unicode 安装器没有 BOM 时中文会乱码。
;    用 Edit 改完记得检查前三字节仍是 EF BB BF。
;
; ⚠ 页面函数一律写在宏体里，不要写在文件头：本文件在 MUI2.nsh 之前被 include，
;    文件头还没有 MUI_HEADER_TEXT 这些宏；宏体的展开点在 assistedInstaller.nsh，
;    那时 MUI2 和 $appExe / $launchLink 都已就绪。
;
; ⚠ electron-builder 用 /WX 把警告当错误：变量声明了没用到（6001）、
;    函数定义了没引用（6010）都会让整包失败。所以安装器专用和卸载器专用的
;    变量 / 函数必须各自用 BUILD_UNINSTALLER 分开。

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!define GRB_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define GRB_RUN_NAME "GenshinRouteBuddy"
!define GRB_HOMEPAGE "https://github.com/FinalLawer/GIFA"

!ifndef BUILD_UNINSTALLER
  ; 中途点「取消」先确认一次，免得手滑把装到一半的向导关掉
  !define MUI_ABORTWARNING
  !define MUI_ABORTWARNING_TEXT "安装还没有完成，确定要退出安装向导吗？"

  ; 自定义页的选项，customInstall 里读取并用它们写文件 / 注册表
  Var /GLOBAL grbDlg
  Var /GLOBAL grbChkMigrate
  Var /GLOBAL grbChkLogin
  Var /GLOBAL grbChkAutoRun
  Var /GLOBAL grbLblDir
  Var /GLOBAL grbDirEdit
  Var /GLOBAL grbBrowseBtn
  Var /GLOBAL grbWantMigrate
  Var /GLOBAL grbMigrateDir
  Var /GLOBAL grbWithLogin
  Var /GLOBAL grbAutoRun
!else
  !define MUI_UNABORTWARNING
  !define MUI_UNABORTWARNING_TEXT "确定要退出卸载向导吗？程序不会被卸载。"

  Var /GLOBAL grbUnDlg
  Var /GLOBAL grbUnChkData
  Var /GLOBAL grbUnDeleteData
  Var /GLOBAL grbUnDataDir
  Var /GLOBAL grbUnFinishText
!endif

; ================================================================== 界面字体
; NSIS 简体中文默认用 MS Shell Dlg，在中文系统上落到点阵宋体，和程序本身的界面格格不入。
; 换成微软雅黑 UI（Win8 起系统自带）。模板在 addLangs 之后才展开 customHeader，
; 那时 LANG_SIMPCHINESE 才有定义，所以不能写在文件头。安装器和卸载器都会走到这里。
!macro customHeader
  SetFont /LANG=${LANG_SIMPCHINESE} "Microsoft YaHei UI" 9
  ; NSIS 简体中文语言包把卸载器标题叫「解除安装」，和页面里的「卸载」对不上
  !ifdef BUILD_UNINSTALLER
    UninstallCaption "${PRODUCT_NAME} 卸载"
  !endif
!macroend

; ================================================================== 安装器

; ---------------------------------------------------------------- 欢迎页
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎安装 原神跟跑助手 ${VERSION}"
  !define MUI_WELCOMEPAGE_TEXT "原神跟跑助手是一个置顶在游戏之上的 B 站攻略视频浮窗：读出视频里小地图的行进方向（红箭头）与镜头朝向（绿弧），实时标在你自己的小地图上。$\r$\n$\r$\n开始之前：$\r$\n  •  旧版本正在运行的话，请先关掉$\r$\n  •  需要管理员权限，快捷键才能在游戏里生效$\r$\n  •  升级安装会保留设置和小地图标定$\r$\n$\r$\n点击「下一步」继续。"
  ; MUI2 展开页面宏时自己会 !undef 这些 define；这里再 undef 会触发
  ; 6155 警告，而 electron-builder 的 /WX 会把警告当错误 ⇒ 不要重复清理。
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ------------------------------------------------------- 初始化页面变量
!macro customInit
  StrCpy $grbWantMigrate "0"
  StrCpy $grbMigrateDir ""
  StrCpy $grbWithLogin "0"
  ; 「开机自启」沿用上一次安装的选择：以前每次升级都默认不勾，
  ; 一路下一步就会把用户原来设好的自启悄悄删掉
  StrCpy $grbAutoRun "0"
  ReadRegStr $0 HKCU "${GRB_RUN_KEY}" "${GRB_RUN_NAME}"
  ${If} $0 != ""
    StrCpy $grbAutoRun "1"
  ${EndIf}
!macroend

; ------------------------------------------- 目录页之后：安装选项自定义页
; 模板只在安装器脚本里展开这个宏，所以里面的函数不需要 BUILD_UNINSTALLER 守卫；
; 文件头的变量声明才需要（见上方 !ifndef BUILD_UNINSTALLER）。
!macro customPageAfterChangeDir
  Page custom grbOptionsPageCreate grbOptionsPageLeave

  ; 迁移相关的三个控件只在勾选「迁移」后可用，没勾时置灰，一眼看出它们是一组
  Function grbSyncMigrateControls
    ${NSD_GetState} $grbChkMigrate $0
    ${If} $0 == ${BST_CHECKED}
      EnableWindow $grbLblDir 1
      EnableWindow $grbDirEdit 1
      EnableWindow $grbBrowseBtn 1
      EnableWindow $grbChkLogin 1
    ${Else}
      EnableWindow $grbLblDir 0
      EnableWindow $grbDirEdit 0
      EnableWindow $grbBrowseBtn 0
      EnableWindow $grbChkLogin 0
    ${EndIf}
  FunctionEnd

  Function grbOnToggleMigrate
    Pop $R0
    Call grbSyncMigrateControls
  FunctionEnd

  Function grbOnBrowse
    Pop $R0
    ${NSD_GetText} $grbDirEdit $R2
    ${If} $R2 == ""
      StrCpy $R2 "$DOCUMENTS"
    ${EndIf}
    nsDialogs::SelectFolderDialog "选择旧绿色版所在的文件夹（里面有 data 子目录）" "$R2"
    Pop $R1
    ${If} $R1 != "error"
      ${NSD_SetText} $grbDirEdit "$R1"
    ${EndIf}
  FunctionEnd

  Function grbOptionsPageCreate
    !insertmacro MUI_HEADER_TEXT "安装选项" "选择启动方式，以及是否把旧绿色版的数据带过来。"

    nsDialogs::Create 1018
    Pop $grbDlg
    ${If} $grbDlg == error
      Abort
    ${EndIf}

    ${NSD_CreateGroupBox} 0 0 100% 30u "启动"
    Pop $0
    ${NSD_CreateCheckBox} 10u 13u 92% 10u "开机时自动打开启动器"
    Pop $grbChkAutoRun

    ${NSD_CreateGroupBox} 0 36u 100% 76u "从旧绿色版迁移数据（可选）"
    Pop $0
    ${NSD_CreateCheckBox} 10u 49u 92% 10u "把旧绿色版的设置和小地图标定迁移过来"
    Pop $grbChkMigrate
    ${NSD_OnClick} $grbChkMigrate grbOnToggleMigrate

    ${NSD_CreateLabel} 21u 63u 88% 9u "旧绿色版所在的文件夹（里面有 data 子目录）："
    Pop $grbLblDir
    ${NSD_CreateDirRequest} 21u 74u 210u 12u ""
    Pop $grbDirEdit
    ${NSD_CreateBrowseButton} 235u 73u 54u 14u "浏览(&B)..."
    Pop $grbBrowseBtn
    ${NSD_OnClick} $grbBrowseBtn grbOnBrowse

    ${NSD_CreateCheckBox} 21u 92u 88% 10u "同时迁移 B 站登录态（只在本机复制，免去重新扫码）"
    Pop $grbChkLogin

    ${NSD_CreateLabel} 0 118u 100% 20u "不迁移就是全新安装，旧文件夹不会被改动。安装版的设置保存在 %APPDATA%\原神跟跑助手\，卸载时默认保留，重装可以直接接着用。"
    Pop $0

    ; 点「上一步」再回来时，把刚才的选择恢复出来
    ${If} $grbAutoRun == "1"
      ${NSD_Check} $grbChkAutoRun
    ${EndIf}
    ${If} $grbWantMigrate == "1"
      ${NSD_Check} $grbChkMigrate
    ${EndIf}
    ${NSD_SetText} $grbDirEdit "$grbMigrateDir"
    ${If} $grbWithLogin == "1"
      ${NSD_Check} $grbChkLogin
    ${EndIf}
    Call grbSyncMigrateControls

    nsDialogs::Show
  FunctionEnd

  Function grbOptionsPageLeave
    ${NSD_GetState} $grbChkAutoRun $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $grbAutoRun "1"
    ${Else}
      StrCpy $grbAutoRun "0"
    ${EndIf}

    ${NSD_GetText} $grbDirEdit $grbMigrateDir
    ${NSD_GetState} $grbChkLogin $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $grbWithLogin "1"
    ${Else}
      StrCpy $grbWithLogin "0"
    ${EndIf}

    ${NSD_GetState} $grbChkMigrate $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $grbWantMigrate "1"
      ${If} $grbMigrateDir == ""
 MessageBox MB_OK|MB_ICONEXCLAMATION "已勾选迁移，请先选择旧绿色版所在的文件夹，或者取消勾选。"
 Abort
      ${EndIf}
      ; 主进程认两种写法：绿色版根目录，或它里面的 data 目录
      ${IfNot} ${FileExists} "$grbMigrateDir\data\settings.json"
      ${AndIfNot} ${FileExists} "$grbMigrateDir\settings.json"
        MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "在这个文件夹里没有找到 settings.json：$\r$\n$grbMigrateDir$\r$\n$\r$\n它可能不是旧绿色版的文件夹，迁移不会生效。$\r$\n仍然继续安装吗？" IDYES grbLeaveOk
        Abort
        grbLeaveOk:
      ${EndIf}
    ${Else}
      StrCpy $grbWantMigrate "0"
    ${EndIf}
  FunctionEnd
!macroend

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
  ${If} $grbWantMigrate == "1"
  ${AndIf} $grbMigrateDir != ""
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
    WriteRegStr HKCU "${GRB_RUN_KEY}" "${GRB_RUN_NAME}" '"$appExe"'
  ${Else}
    DeleteRegValue HKCU "${GRB_RUN_KEY}" "${GRB_RUN_NAME}"
  ${EndIf}
!macroend

; --------------------------------------------------------------- 完成页
; 函数定义在宏体里而不是文件头：展开点在 installer.nsi 之后，
; 那时 $appExe / $launchLink 已经 Var 声明过，编译不会报未知变量。
!macro customFinishPage
  Function grbStartApp
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  FunctionEnd
  !define MUI_FINISHPAGE_TITLE "安装完成"
  ; 带「立即启动」复选框时，MUI 留给正文的高度只有 40u（约 4 行），加 TEXT_LARGE 也才 60u。
  ; 所以每条都压到一行以内，超出的部分会被直接裁掉而不是换行显示。
  !define MUI_FINISHPAGE_TEXT_LARGE
  !define MUI_FINISHPAGE_TEXT "原神跟跑助手 ${VERSION} 已经装好。$\r$\n$\r$\n  •  首次运行会弹一次 UAC，请点「是」$\r$\n  •  游戏请用「窗口化」或「无边框」模式$\r$\n  •  设置和小地图标定在卸载时默认保留"
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "立即启动 原神跟跑助手"
  !define MUI_FINISHPAGE_RUN_FUNCTION "grbStartApp"
  !define MUI_FINISHPAGE_LINK "查看使用说明与更新日志"
  !define MUI_FINISHPAGE_LINK_LOCATION "${GRB_HOMEPAGE}#readme"
  !insertmacro MUI_PAGE_FINISH
!macroend

; ================================================================== 卸载器

; 静默卸载（/S）和升级时安装器调起的卸载都不显示页面，
; 这里的默认值保证那两条路径永远不删用户数据。
!macro customUnInit
  StrCpy $grbUnDeleteData "0"
  StrCpy $grbUnDataDir ""
  StrCpy $grbUnFinishText ""
!macroend

; ---------------------------------------- 卸载欢迎页 + 「要不要删数据」选项页
!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "卸载 原神跟跑助手 ${VERSION}"
  !define MUI_WELCOMEPAGE_TEXT "本向导会从这台电脑移除原神跟跑助手。$\r$\n$\r$\n将会移除：$\r$\n  •  程序文件$\r$\n  •  开始菜单和桌面上的快捷方式$\r$\n  •  开机自启设置$\r$\n$\r$\n你的设置、小地图标定和 B 站登录态默认保留，下一步可以选择是否一并删除。$\r$\n$\r$\n继续之前，请先关闭浮窗和启动器。"
  !insertmacro MUI_UNPAGE_WELCOME

  UninstPage custom un.grbUnOptionsCreate un.grbUnOptionsLeave

  Function un.grbUnOptionsCreate
    !insertmacro MUI_HEADER_TEXT "卸载选项" "选择是否保留你的数据。"

    ; Electron 的 userData 永远在当前用户的 %APPDATA% 下；
    ; 「为所有用户安装」时 $APPDATA 会指向 ProgramData，要临时切回当前用户再取
    SetShellVarContext current
    StrCpy $grbUnDataDir "$APPDATA\${PRODUCT_FILENAME}"
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}

    nsDialogs::Create 1018
    Pop $grbUnDlg
    ${If} $grbUnDlg == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 20u "程序文件、快捷方式和开机自启设置都会被移除。你的个人数据单独存放，由你决定去留："
    Pop $0

    ${NSD_CreateGroupBox} 0 26u 100% 70u "我的数据"
    Pop $0
    ${NSD_CreateLabel} 10u 39u 92% 9u "设置、小地图标定、观看记录和 B 站登录态保存在："
    Pop $0
    ${NSD_CreateText} 10u 50u 92% 12u "$grbUnDataDir"
    Pop $0
    SendMessage $0 ${EM_SETREADONLY} 1 0
    ${NSD_CreateCheckBox} 10u 68u 92% 10u "同时删除以上数据（删除后无法恢复）"
    Pop $grbUnChkData
    ${NSD_CreateLabel} 21u 81u 88% 9u "不勾选就保留，以后重新安装可以直接接着用。"
    Pop $0

    ${If} $grbUnDeleteData == "1"
      ${NSD_Check} $grbUnChkData
    ${EndIf}

    ; 这一页之后就开始卸载，按钮写明白，别让人以为还有下一步
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:卸载(&U)"

    nsDialogs::Show
  FunctionEnd

  Function un.grbUnOptionsLeave
    ${NSD_GetState} $grbUnChkData $0
    ${If} $0 == ${BST_CHECKED}
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "确定要删除你的设置、小地图标定和 B 站登录态吗？$\r$\n$\r$\n$grbUnDataDir$\r$\n$\r$\n删除后无法恢复。" IDYES grbUnConfirmed
      Abort
      grbUnConfirmed:
      StrCpy $grbUnDeleteData "1"
    ${Else}
      StrCpy $grbUnDeleteData "0"
    ${EndIf}
  FunctionEnd
!macroend

; --------------------------------------------------------------- 卸载时
; 默认只清理安装页自己写的东西；%APPDATA% 里的设置 / 标定 / 登录态只有在
; 卸载选项页明确勾选后才删（package.json 里 deleteAppDataOnUninstall: false，
; 卸载器自己不会删 userData）。
!macro customUnInstall
  Delete "$INSTDIR\installed.flag"
  Delete "$INSTDIR\migrate-from.txt"
  DeleteRegValue HKCU "${GRB_RUN_KEY}" "${GRB_RUN_NAME}"

  ${If} $grbUnDeleteData == "1"
  ${AndIf} $grbUnDataDir != ""
    SetShellVarContext current
    RMDir /r "$grbUnDataDir"
    ; Electron 的缓存 / IndexedDB 有时落在 package.json 的 name 目录下
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
    StrCpy $grbUnFinishText "原神跟跑助手已经从这台电脑移除，你的设置、小地图标定和 B 站登录态也已一并删除。$\r$\n$\r$\n感谢使用。"
  ${Else}
    StrCpy $grbUnFinishText "原神跟跑助手已经从这台电脑移除。$\r$\n$\r$\n你的设置、小地图标定和 B 站登录态仍保留在 %APPDATA%\${PRODUCT_FILENAME}\，以后重新安装可以直接接着用；想彻底清掉，手动删除这个文件夹即可。$\r$\n$\r$\n感谢使用。"
  ${EndIf}
!macroend

; ------------------------------------------------------------- 卸载完成页
; 模板在这个宏之后紧跟着插入 MUI_UNPAGE_FINISH，这里只负责把文案换掉。
; 正文用变量：留没留数据要到卸载执行完才知道，页面显示时才取值。
!macro customUninstallPage
  !define MUI_FINISHPAGE_TITLE "卸载完成"
  !define MUI_FINISHPAGE_TEXT "$grbUnFinishText"
  !define MUI_FINISHPAGE_LINK "遇到问题？到项目主页反馈"
  !define MUI_FINISHPAGE_LINK_LOCATION "${GRB_HOMEPAGE}/issues"
!macroend
