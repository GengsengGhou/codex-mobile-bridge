param([Parameter(Mandatory=$true)][string]$SetupExecutable, [string]$OutputDirectory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$fixture=Join-Path $env:TEMP ('codex-language-qa-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
function Assert($value,$message){if(-not $value){throw $message}}
try {
    $assembly=[Reflection.Assembly]::LoadFile([IO.Path]::GetFullPath($SetupExecutable))
    $locale=$assembly.GetType('DesktopLocale')
    $flags=[Reflection.BindingFlags]'Static,Public'
    $load=$locale.GetMethod('Load',$flags);$save=$locale.GetMethod('Save',$flags);$field=$locale.GetField('Language',$flags)
    $root=Join-Path $fixture 'app'
    New-Item -ItemType Directory -Path (Join-Path $root '.local') | Out-Null
    [Globalization.CultureInfo]::CurrentUICulture=[Globalization.CultureInfo]'zh-CN'
    $load.Invoke($null,[object[]]@([string]$root));Assert ($field.GetValue($null) -eq 'zh-CN') 'Chinese OS default failed.'
    [Globalization.CultureInfo]::CurrentUICulture=[Globalization.CultureInfo]'en-US'
    $load.Invoke($null,[object[]]@([string]$root));Assert ($field.GetValue($null) -eq 'en') 'English OS default failed.'
    foreach($data in @('{broken','{"language":"fr"}','{"language":true}','null')) {
        [IO.File]::WriteAllText((Join-Path $root '.local/desktop-language.json'),$data)
        $load.Invoke($null,[object[]]@([string]$root));Assert ($field.GetValue($null) -eq 'en') 'Damaged preference did not safely default.'
    }
    $save.Invoke($null,[object[]]@([string]$root,'zh-CN'));$load.Invoke($null,[object[]]@([string]$root));Assert ($field.GetValue($null) -eq 'zh-CN') 'Saved preference did not override OS.'
    $before=[IO.File]::ReadAllText((Join-Path $root '.local/desktop-language.json'))
    $rejected=$false;try{$save.Invoke($null,[object[]]@([string]$root,'xx'))}catch{$rejected=$true};Assert $rejected 'Unsupported locale was accepted.'
    Assert ([IO.File]::ReadAllText((Join-Path $root '.local/desktop-language.json')) -ceq $before) 'Invalid locale changed saved preference.'
    $windows=@()
    foreach($selected in @('zh-CN','en')) {
        $save.Invoke($null,[object[]]@([string]$root,$selected))
        $form=[Activator]::CreateInstance($assembly.GetType('InstallerWindow'),[object[]]@([string]$root,[bool]$false,[string[]]@()))
        try {
            $body=$form.Controls[0];$combo=@($body.Controls | Where-Object {$_ -is [Windows.Forms.ComboBox]})[0]
            $button=@($body.Controls | Where-Object {$_ -is [Windows.Forms.Button]})[0]
            Assert ($form.Text -ceq 'Codex Mobile Bridge') 'Installer window branding changed by locale.'
            Assert ($combo.Items[0] -ceq ([string][char]0x4e2d+[char]0x6587) -and $combo.Items[1] -ceq 'English') 'Installer language options missing.'
            Assert ($combo.SelectedIndex -eq $(if($selected -eq 'en'){1}else{0})) 'Installer did not honor saved language.'
            Assert ($button.Text -ceq $(if($selected -eq 'en'){'Install'}else{[string][char]0x5b89+[char]0x88c5})) 'Installer button locale failed.'
            $combo.SelectedIndex=1-$combo.SelectedIndex
            Assert ($button.Text -ceq $(if($selected -eq 'en'){[string][char]0x5b89+[char]0x88c5}else{'Install'})) 'Language choice did not immediately update installer.'
            Assert ([IO.File]::ReadAllText((Join-Path $root '.local/desktop-language.json')) -ceq ('{"language":"'+$selected+'"}')) 'Uninstalled selection wrote preferences early.'
            $combo.SelectedIndex=$(if($selected -eq 'en'){1}else{0});$form.Show();[Windows.Forms.Application]::DoEvents();$form.CreateControl();$bitmap=New-Object Drawing.Bitmap($form.Width,$form.Height);$form.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$form.Width,$form.Height)))
            if($OutputDirectory){New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null;$bitmap.Save((Join-Path $OutputDirectory ('installer-choice-'+$selected+'.png')))};$bitmap.Dispose()
            $windows+=@{initialLanguage=$selected;choiceRendered=$true;liveLabels=$true;noEarlyPersistence=$true}
        } finally {$form.Dispose()}
    }
    $dialogCreate=$assembly.GetType('DesktopDialog').GetMethod('Create',[Reflection.BindingFlags]'Static,NonPublic')
    foreach($selected in @('zh-CN','en')) {
        $field.SetValue($null,$selected)
        $confirmation=$locale.GetMethod('T').Invoke($null,[object[]]@([string]'卸载应用和登录启动项？已保存的配对和本机数据将保留。'))
        $dialog=$dialogCreate.Invoke($null,[object[]]@([string]$confirmation,[Windows.Forms.MessageBoxButtons]::OKCancel))
        try {
            Assert ($dialog.Text -ceq 'Codex Mobile Bridge') 'Confirmation title locale changed branding.'
            $buttons=@($dialog.Controls[0].Controls[1].Controls | ForEach-Object Text)
            Assert ($buttons[0] -ceq $(if($selected -eq 'en'){'OK'}else{'确定'})) 'Confirmation accept not localized.'
            Assert ($buttons[1] -ceq $(if($selected -eq 'en'){'Cancel'}else{'取消'})) 'Confirmation cancel not localized.'
            $dialog.Show();[Windows.Forms.Application]::DoEvents();$dialog.CreateControl();$bitmap=New-Object Drawing.Bitmap($dialog.Width,$dialog.Height);$dialog.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$dialog.Width,$dialog.Height)));if($OutputDirectory){$bitmap.Save((Join-Path $OutputDirectory ('uninstall-dialog-'+$selected+'.png')))};$bitmap.Dispose()
        }finally{$dialog.Dispose()}
        $message=$locale.GetMethod('T').Invoke($null,[object[]]@([string]'请安装 Microsoft Edge WebView2 Runtime，然后重新打开连接器。配对数据会保留。'))
        $recovery=[Activator]::CreateInstance($assembly.GetType('DependencyWindow'),[object[]]@([string]$root,[string]$message,[string]'WebView2RuntimeNotFoundException',$null))
        try {
            Assert ($recovery.Text -ceq 'Codex Mobile Bridge') 'Recovery title branding changed.'
            Assert ($recovery.Controls[0].Controls[0].Text -ceq $(if($selected -eq 'en'){'This app requires WebView2'}else{'连接器需要 WebView2'})) 'Recovery heading not localized.'
            $recovery.Show();[Windows.Forms.Application]::DoEvents();$recovery.CreateControl();$bitmap=New-Object Drawing.Bitmap($recovery.Width,$recovery.Height);$recovery.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$recovery.Width,$recovery.Height)));if($OutputDirectory){$bitmap.Save((Join-Path $OutputDirectory ('recovery-'+$selected+'.png')))};$bitmap.Dispose()
        }finally{$recovery.Dispose()}
    }
    $result=@{passed=$true;surface='Reflection of actual compiled Windows EXE forms and preference implementation';osCultureDefaults=$true;corruptAndInvalidPreferenceFallback=$true;invalidLocaleWriteRejected=$true;preferenceContainsOnlyLanguage=$true;installerWindows=$windows;localizedUninstallButtons=$true;bilingualMissingWebViewRecovery=$true;physicalMouseClicksTested=$false;realInstallationModified=$false}
    $result|ConvertTo-Json -Depth 5
    if($OutputDirectory){$result|ConvertTo-Json -Depth 5|Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'native-language-evidence.json')}
} finally {if([IO.Path]::GetFullPath($fixture).StartsWith([IO.Path]::GetFullPath($env:TEMP)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){Remove-Item -LiteralPath $fixture -Recurse -Force}}
