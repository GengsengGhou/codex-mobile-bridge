using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyVersion("0.2.2.0")]
[assembly: AssemblyFileVersion("0.2.2.0")]
[assembly: AssemblyInformationalVersion("0.2.2")]
[assembly: AssemblyTitle("Codex Mobile Bridge")]
[assembly: AssemblyProduct("Codex Mobile Bridge")]
[assembly: AssemblyDescription("Codex Mobile Bridge")]

// Keep setup and dependency recovery independent of WebView2 type loading.
static class ConnectorBootstrap {
    public static void ClearRuntimeOverrides(ProcessStartInfo start) {
        foreach(var name in new[]{"CODEX_THREAD_ID","BRIDGE_ENABLE_SEND","BRIDGE_SEND_THREAD_ID","BRIDGE_SEND_SCOPE","BRIDGE_PORT"})start.EnvironmentVariables.Remove(name);
    }
    static string qaUninstallDecision,qaUninstallEvidence;
    [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern void SHChangeNotify(uint eventId,uint flags,string path,IntPtr item);
    [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
    [DllImport("user32.dll")]static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("shcore.dll")]static extern int SetProcessDpiAwareness(int awareness);
    [DllImport("user32.dll")]static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")]static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")]static extern bool AreDpiAwarenessContextsEqual(IntPtr a,IntPtr b);
    public static uint WindowDpi(Form form){try{return GetDpiForWindow(form.Handle);}catch(EntryPointNotFoundException){using(var graphics=form.CreateGraphics())return (uint)graphics.DpiX;}}
    public static bool PerMonitorV2(){try{return AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),new IntPtr(-4));}catch(EntryPointNotFoundException){return false;}}
    static void EnableDpiAwareness(){try{if(SetProcessDpiAwarenessContext(new IntPtr(-4)))return;}catch(EntryPointNotFoundException){}try{SetProcessDpiAwareness(2);}catch(DllNotFoundException){SetProcessDPIAware();}}
    public static readonly string Version = ((AssemblyInformationalVersionAttribute)Attribute.GetCustomAttribute(Assembly.GetExecutingAssembly(), typeof(AssemblyInformationalVersionAttribute))).InformationalVersion;
    public static bool IsDefaultRoot(string path) { return string.Equals(Path.GetFullPath(path),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexMobileConnector"),StringComparison.OrdinalIgnoreCase); }
    public static Icon BrandIcon() { using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("icons.connector.ico")) return stream==null?Icon.ExtractAssociatedIcon(Application.ExecutablePath):new Icon(stream); }
    public static void EnsureShortcut(string root,bool includeDesktop=false) {
        if(!IsDefaultRoot(root))return;
        RefreshShortcuts(root,Environment.GetFolderPath(Environment.SpecialFolder.Programs),Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),includeDesktop);
    }
    static bool OwnedShortcut(dynamic link,string executable,string root) {
        return string.Equals((string)link.TargetPath,executable,StringComparison.OrdinalIgnoreCase)&&string.Equals((string)link.WorkingDirectory,root,StringComparison.OrdinalIgnoreCase)&&string.IsNullOrWhiteSpace((string)link.Arguments);
    }
    // Separate paths let acceptance exercise the real COM implementation in temporary folders.
    static void RefreshShortcuts(string root,string programs,string desktop,bool includeDesktop) {
        string executable=Path.Combine(root,"CodexMobileConnector.exe");
        dynamic shell=Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        try {
            foreach(string directory in includeDesktop?new[]{programs,desktop}:new[]{programs}) {
                Directory.CreateDirectory(directory);
                string shortcut=Path.Combine(directory,"Codex Mobile Bridge.lnk");
                bool existed=File.Exists(shortcut);
                bool changed=false;
                dynamic link=shell.CreateShortcut(shortcut);
                try {
                    if(File.Exists(shortcut)&&!OwnedShortcut(link,executable,root))throw new IOException(DesktopLocale.T("快捷方式属于其他程序，无法替换：")+shortcut);
                    if(!File.Exists(shortcut)||!string.Equals(((string)link.IconLocation).Trim(),executable+",0",StringComparison.OrdinalIgnoreCase)||((string)link.Description)!="Codex Mobile Bridge") {
                        link.TargetPath=executable;link.Arguments="";link.WorkingDirectory=root;link.Description="Codex Mobile Bridge";link.IconLocation=executable+",0";link.Save();
                        changed=true;
                    }
                } finally {Marshal.FinalReleaseComObject(link);}
                if(ShortcutIdentity.Ensure(shortcut)||changed){SHChangeNotify(existed?0x2000u:0x2u,0x0005,shortcut,IntPtr.Zero);SHChangeNotify(0x1000,0x0005,directory,IntPtr.Zero);}
                foreach(string legacyName in new[]{"Codex Mobile Connector.lnk","Codex \u624b\u673a\u6865\u63a5.lnk"}) {
                string legacy=Path.Combine(directory,legacyName);
                if(File.Exists(legacy)) {
                    dynamic old=shell.CreateShortcut(legacy);
                    try {if(OwnedShortcut(old,executable,root)){File.Delete(legacy);SHChangeNotify(0x4,0x0005,legacy,IntPtr.Zero);SHChangeNotify(0x1000,0x0005,directory,IntPtr.Zero);}}
                    finally {Marshal.FinalReleaseComObject(old);}
                }}
            }
        } finally {Marshal.FinalReleaseComObject(shell);}
    }
    public static string ValidatedHub(string value) {
        Uri uri;
        if(string.IsNullOrWhiteSpace(value)||value.Length>2048||!Uri.TryCreate(value.Trim(),UriKind.Absolute,out uri)||uri.Scheme!="https"||uri.AbsolutePath!="/"||uri.Query!=""||uri.Fragment!=""||uri.UserInfo!=""||uri.HostNameType==UriHostNameType.Unknown) throw new Exception(DesktopLocale.T("请输入 HTTPS 服务器地址，不包含路径、账号或参数。"));
        return uri.GetLeftPart(UriPartial.Authority)+"/";
    }
    public static void Open(string target) { Process.Start(new ProcessStartInfo(target){UseShellExecute=true}); }
    public static string RequestJson(object request){var encoded=new StringBuilder();foreach(char c in new JavaScriptSerializer().Serialize(request)){if(c>127)encoded.Append("\\u").Append(((int)c).ToString("x4"));else encoded.Append(c);}return encoded.ToString();}
    public static void Restart(string root,Form form) {
        string executable=Application.ExecutablePath.Replace("'","''"),arguments=("--install-root \""+root+"\"").Replace("'","''");
        string script="Wait-Process -Id "+Process.GetCurrentProcess().Id+" -ErrorAction SilentlyContinue; Start-Process -FilePath '"+executable+"' -ArgumentList '"+arguments+"' -WindowStyle Hidden";
        Process.Start(new ProcessStartInfo("powershell.exe","-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(script))){UseShellExecute=false,CreateNoWindow=true});form.Close();
    }
    static string Argument(string[] args,string flag) { int i=Array.IndexOf(args,flag);return i>=0&&i+1<args.Length?args[i+1]:null; }
    public static void DependencyEvidence(Form form,string root,string[] args) {
        string output=Argument(args,"--qa-dependency-evidence");if(IsDefaultRoot(root)||output==null)return;
        form.Shown+=(s,e)=>{using(var bitmap=new Bitmap(form.Width,form.Height)){form.DrawToBitmap(bitmap,new Rectangle(0,0,form.Width,form.Height));bitmap.Save(output+".png");}File.WriteAllText(output,new JavaScriptSerializer().Serialize(new{nativeRecoveryWindow=true,title=form.Text,webviewLoaded=false,controlsRendered=output+".png",physicalWindowsInputTested=false}));};
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    static Form InstalledWindow(string root,string[] args) { return new ConnectorWindow(root,args); }
    [STAThread] static void Main(string[] args) {
        SetCurrentProcessExplicitAppUserModelID(ShortcutIdentity.AppId);
        EnableDpiAwareness();Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        string root=Argument(args,"--install-root")??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexMobileConnector");
        root=Path.GetFullPath(root);DesktopLocale.Load(root);
        if(!IsDefaultRoot(root)){qaUninstallDecision=Argument(args,"--qa-uninstall-decision");qaUninstallEvidence=Argument(args,"--qa-uninstall-evidence");}
        if(args.Length==1&&args[0]=="--tray")root=Path.GetDirectoryName(Application.ExecutablePath);
        bool installed=string.Equals(Path.GetDirectoryName(Application.ExecutablePath),root,StringComparison.OrdinalIgnoreCase), startup=Array.IndexOf(args,"--tray")>=0, uninstall=Array.IndexOf(args,"--uninstall")>=0;
        if(installed&&!uninstall&&IsDefaultRoot(root))try{EnsureShortcut(root);}catch{}
        string identity;
        using(var sha=SHA256.Create())identity=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()+"|"+WindowsIdentity.GetCurrent().User.Value))).Replace("-","");
        if(!installed)identity+="-setup";
        bool owner;
        using(var mutex=new Mutex(true,@"Global\CodexMobileCompanion-"+identity,out owner))
        using(var wake=new EventWaitHandle(false,EventResetMode.AutoReset,@"Global\CodexMobileCompanionWake-"+identity))
        using(var remove=new EventWaitHandle(false,EventResetMode.AutoReset,@"Global\CodexMobileCompanionUninstall-"+identity)) {
            string instanceEvidence=!IsDefaultRoot(root)?Argument(args,"--qa-instance-evidence"):null;
            if(!owner){if(installed&&uninstall)remove.Set();else if(!startup)wake.Set();if(instanceEvidence!=null)File.WriteAllText(instanceEvidence,new JavaScriptSerializer().Serialize(new{owner=false,installed=installed,wokeExisting=!startup&&!uninstall}));return;}
            Form form;
            if(!installed)form=new InstallerWindow(root,Array.IndexOf(args,"--install")>=0,args);
            else if(uninstall)form=new UninstallWindow(root);
            else {
                try { form=InstalledWindow(root,args); }
                catch(Exception error) { form=new DependencyWindow(root,DesktopLocale.T("连接器组件无法载入。请保留本机数据，卸载后重新安装。"),error.GetType().Name);DependencyEvidence(form,root,args); }
            }
            int wakeCount=0;Action record=()=>{if(instanceEvidence!=null){var connector=form as IConnectorWindow;File.WriteAllText(instanceEvidence,new JavaScriptSerializer().Serialize(new{owner=true,installed=installed,wakeCount=wakeCount,visible=(connector!=null?connector.DialogOwner:form).Visible,windowDpi=WindowDpi(form),perMonitorV2=PerMonitorV2()}));}};
            form.Shown+=(s,e)=>{if(instanceEvidence!=null&&Array.IndexOf(args,"--qa-instance-hide")>=0)form.Hide();record();};
            Task.Run(()=>{while(!form.IsDisposed){int action=WaitHandle.WaitAny(new WaitHandle[]{wake,remove},1000);if(action<2&&form.IsHandleCreated&&!form.IsDisposed)try{form.BeginInvoke(new Action(()=>{if(action==0){var connector=form as IConnectorWindow;if(connector!=null)connector.Wake();else {form.Show();form.WindowState=FormWindowState.Normal;form.Activate();}wakeCount++;record();}else if(installed)RequestUninstall(form,root);}));}catch(InvalidOperationException){}}});
            Application.Run(form);
            if(owner)mutex.ReleaseMutex();
        }
    }
    public static bool RequestUninstall(Form form,string root) {
        var connector=form as IConnectorWindow;if(connector!=null&&connector.RecordUninstallIntent())return false;
        Form dialog=connector!=null?connector.DialogOwner:form;
        if(connector!=null&&!connector.BeginUninstall()){DesktopDialog.Show(dialog,DesktopLocale.T("正在完成上一操作，请稍后卸载。"),"Codex Mobile Bridge",MessageBoxButtons.OK,MessageBoxIcon.Information);return false;}
        bool confirmed=qaUninstallDecision!=null&&!IsDefaultRoot(root)?qaUninstallDecision=="confirm":DesktopDialog.Show(dialog,DesktopLocale.T("卸载应用和登录启动项？已保存的配对和本机数据将保留。"),"Codex Mobile Bridge",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)==DialogResult.OK;
        if(qaUninstallEvidence!=null&&!IsDefaultRoot(root))File.WriteAllText(qaUninstallEvidence,new JavaScriptSerializer().Serialize(new{confirmationReached=true,confirmed=confirmed,nativeConfirmationClickTested=false,webviewRequired=false}));
        if(!confirmed){if(connector!=null)connector.CancelUninstall();return false;}
        var info=new ProcessStartInfo("powershell.exe","-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \""+Path.Combine(root,"deploy","uninstall-connector.ps1")+"\" -Root \""+root+"\""){UseShellExecute=false,CreateNoWindow=true};
        try{Process.Start(info);if(connector!=null)connector.ExitForUninstall();else form.Close();return true;}catch(Exception error){if(connector!=null)connector.CancelUninstall();DesktopDialog.Show(dialog,error.Message,DesktopLocale.T("无法启动卸载"),MessageBoxButtons.OK,MessageBoxIcon.Warning);return false;}
    }
}
static class ShortcutIdentity {
    public const string AppId="CodexMobileBridge.Connector";
    [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid format;public uint id; }
    [StructLayout(LayoutKind.Explicit,Size=24)] struct PropertyValue { [FieldOffset(0)]public ushort type;[FieldOffset(8)]public IntPtr text; }
    [ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface PropertyStore {
        void GetCount(out uint count);void GetAt(uint index,out PropertyKey key);void GetValue(ref PropertyKey key,out PropertyValue value);void SetValue(ref PropertyKey key,ref PropertyValue value);void Commit();
    }
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropertyValue value);
    public static bool Ensure(string path) {
        object shellLink=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
        try {
            var file=(System.Runtime.InteropServices.ComTypes.IPersistFile)shellLink;file.Load(path,2);
            var store=(PropertyStore)shellLink;var key=new PropertyKey{format=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),id=5};
            PropertyValue existing;store.GetValue(ref key,out existing);
            try {if(existing.type==31&&Marshal.PtrToStringUni(existing.text)==AppId)return false;}finally{PropVariantClear(ref existing);}
            var value=new PropertyValue{type=31,text=Marshal.StringToCoTaskMemUni(AppId)};
            try {store.SetValue(ref key,ref value);store.Commit();file.Save(path,true);}finally{PropVariantClear(ref value);}
            return true;
        } finally {Marshal.FinalReleaseComObject(shellLink);}
    }
}
interface IConnectorWindow { void Wake();Form DialogOwner{get;}bool RecordUninstallIntent();bool BeginUninstall();void CancelUninstall();void ExitForUninstall(); }

class UninstallWindow : Form {
    public UninstallWindow(string root){Text="Codex Mobile Bridge";Icon=ConnectorBootstrap.BrandIcon();ClientSize=new Size(420,100);StartPosition=FormStartPosition.CenterScreen;BackColor=Color.White;Font=new Font("Microsoft YaHei UI",10);AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;Controls.Add(new Label{Text="Codex Mobile Bridge",Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleCenter});Shown+=(s,e)=>{ConnectorBootstrap.RequestUninstall(this,root);if(!IsDisposed)Close();};}
}

class DependencyWindow : Form {
    public DependencyWindow(string root,string message,string detail,Form owner=null) {
        Text="Codex Mobile Bridge";Icon=ConnectorBootstrap.BrandIcon();ClientSize=new Size(530,280);MinimumSize=new Size(480,300);StartPosition=FormStartPosition.CenterScreen;BackColor=Color.White;Font=new Font("Microsoft YaHei UI",10);AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;
        var body=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=1,Padding=new Padding(28),AutoScroll=true};Controls.Add(body);
        body.Controls.Add(new Label{Text=DesktopLocale.T("连接器需要 WebView2"),Font=new Font(Font.FontFamily,15,FontStyle.Bold),AutoSize=true,Margin=new Padding(0,0,0,16)});
        body.Controls.Add(new Label{Text=message,AutoSize=true,MaximumSize=new Size(460,0),Margin=new Padding(0,0,0,10)});
        body.Controls.Add(new Label{Text=detail,AutoSize=true,ForeColor=Color.DimGray,MaximumSize=new Size(460,0),Margin=new Padding(0,0,0,18)});
        var actions=new FlowLayoutPanel{AutoSize=true,Dock=DockStyle.Top};body.Controls.Add(actions);
        var download=new Button{Text=DesktopLocale.T("安装 WebView2"),AutoSize=true,Padding=new Padding(8)};download.Click+=(s,e)=>ConnectorBootstrap.Open("https://go.microsoft.com/fwlink/p/?LinkId=2124703");actions.Controls.Add(download);
        var retry=new Button{Text=DesktopLocale.T("重试"),AutoSize=true,Padding=new Padding(8)};retry.Click+=(s,e)=>ConnectorBootstrap.Restart(root,this);actions.Controls.Add(retry);
        var folder=new Button{Text=DesktopLocale.T("打开安装目录"),AutoSize=true,Padding=new Padding(8)};folder.Click+=(s,e)=>ConnectorBootstrap.Open(root);actions.Controls.Add(folder);
        var remove=new Button{Text=DesktopLocale.T("卸载"),AutoSize=true,Padding=new Padding(8)};remove.Click+=(s,e)=>ConnectorBootstrap.RequestUninstall(owner??this,root);actions.Controls.Add(remove);
    }
}
class InstallerWindow : Form {
    readonly string root;readonly bool unattended;readonly bool upgrading;readonly ComboBox language=new ComboBox();readonly string[] arguments;readonly Label status=new Label();readonly Button install=new Button();
    static bool ExistingInstallation(string path) {
        try {
            string markerPath=Path.Combine(path,"installed.json"),executable=Path.Combine(path,"CodexMobileConnector.exe");
            if(!File.Exists(markerPath)||!File.Exists(executable))return false;
            var marker=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(markerPath));
            if(!marker.ContainsKey("root")||!marker.ContainsKey("version")||Convert.ToInt32(marker["version"])!=1||!string.Equals(Path.GetFullPath(Convert.ToString(marker["root"])),path,StringComparison.OrdinalIgnoreCase))return false;
            string assemblyName=AssemblyName.GetAssemblyName(executable).Name;
            if(assemblyName!="CodexMobileConnector-Setup"&&assemblyName!="CodexMobileConnector")return false;
            var version=new Version(FileVersionInfo.GetVersionInfo(executable).ProductVersion);
            return version.Major>=0;
        } catch {return false;}
    }
    public InstallerWindow(string destination,bool silent,string[] args) {
        root=destination;unattended=silent;arguments=args;bool upgrade=ExistingInstallation(root)||File.Exists(root+".upgrade-journal.json");upgrading=upgrade;DesktopLocale.Load(root);Text="Codex Mobile Bridge";Icon=ConnectorBootstrap.BrandIcon();ClientSize=new Size(550,390);MinimumSize=new Size(510,410);StartPosition=FormStartPosition.CenterScreen;BackColor=Color.White;Font=new Font("Microsoft YaHei UI",10);AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;
        var body=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=1,Padding=new Padding(30),AutoScroll=true};Controls.Add(body);
        body.Controls.Add(new Label{Text="Codex Mobile Bridge",AutoSize=true,Font=new Font(Font.FontFamily,18,FontStyle.Bold),Margin=new Padding(0,0,0,18)});
        body.Controls.Add(new Label{Text=DesktopLocale.T("仅为当前 Windows 用户安装"),AutoSize=true,ForeColor=Color.DimGray,Margin=new Padding(0,0,0,10)});
        body.Controls.Add(new Label{Text=root,AutoSize=true,MaximumSize=new Size(480,0),ForeColor=Color.DimGray,Margin=new Padding(0,0,0,20)});
        language.DropDownStyle=ComboBoxStyle.DropDownList;language.Items.AddRange(new object[]{"中文","English"});language.SelectedIndex=DesktopLocale.Language=="en"?1:0;language.AccessibleName="Language / 语言";body.Controls.Add(new Label{Text="Language / 语言",AutoSize=true});body.Controls.Add(language);language.SelectedIndexChanged+=(s,e)=>{DesktopLocale.Language=language.SelectedIndex==1?"en":"zh-CN";install.Text=DesktopLocale.T(upgrading?"升级":"安装");};
        status.AutoSize=true;status.MaximumSize=new Size(480,0);status.Margin=new Padding(0,0,0,16);body.Controls.Add(status);
        install.Text=upgrade?DesktopLocale.T("升级"):DesktopLocale.T("安装");install.AutoSize=true;install.Padding=new Padding(20,7,20,7);install.BackColor=Color.FromArgb(20,100,71);install.ForeColor=Color.White;install.FlatStyle=FlatStyle.Flat;install.FlatAppearance.BorderSize=0;body.Controls.Add(install);
        int evidence=Array.IndexOf(args,"--qa-upgrade-evidence");if(evidence>=0&&evidence+1<args.Length&&!ConnectorBootstrap.IsDefaultRoot(root))Shown+=(s,e)=>File.WriteAllText(args[evidence+1],new JavaScriptSerializer().Serialize(new{button=install.Text,title=Text}));
        language.SelectedIndexChanged+=(s,e)=>{foreach(Control control in body.Controls)if(control is Label&&control.Text!=root&&control!=status&&control.Text!="Codex Mobile Bridge"&&control.Text!="Language / 语言")control.Text=DesktopLocale.T("仅为当前 Windows 用户安装");};
        int languageArgument=Array.IndexOf(args,"--language");if(languageArgument>=0&&languageArgument+1<args.Length&&DesktopLocale.Valid(args[languageArgument+1]))language.SelectedIndex=args[languageArgument+1]=="en"?1:0;
        install.Click+=async(s,e)=>await Install();if(unattended)Shown+=async(s,e)=>await Install();
    }
    public async Task Install() {
        install.Enabled=false;language.Enabled=false;string chosenLanguage=language.SelectedIndex==1?"en":"zh-CN";status.Text=upgrading?DesktopLocale.T("正在升级应用…"):DesktopLocale.T("正在安装应用和运行环境…");
        try {
            await Task.Run(()=>{
                if(File.Exists(root+".upgrade-journal.json")) {
                    string recoveryStage=Path.Combine(Path.GetTempPath(),"codex-upgrade-"+Guid.NewGuid().ToString("N"));
                    try {Directory.CreateDirectory(recoveryStage);ExtractPayload(recoveryStage);File.Copy(Application.ExecutablePath,Path.Combine(recoveryStage,"CodexMobileConnector.exe"));RunUpgradeHelper(recoveryStage,true);}
                    finally {try{Directory.Delete(recoveryStage,true);}catch{}}
                    if(File.Exists(Path.Combine(root,"CodexMobileConnector.exe"))&&string.Equals(FileVersionInfo.GetVersionInfo(Path.Combine(root,"CodexMobileConnector.exe")).ProductVersion,ConnectorBootstrap.Version,StringComparison.OrdinalIgnoreCase)) {
                        if(ConnectorBootstrap.IsDefaultRoot(root)){ConnectorBootstrap.EnsureShortcut(root,true);Register();}
                        return;
                    }
                }
                bool upgrade=Directory.Exists(root)&&Directory.GetFileSystemEntries(root).Any(item=>Path.GetFileName(item)!=".local");
                if(upgrade) {
                    if(!ExistingInstallation(root))throw new Exception(DesktopLocale.T("安装目录归属无法验证；不会覆盖现有文件。"));
                    string stage=Path.Combine(Path.GetTempPath(),"codex-upgrade-"+Guid.NewGuid().ToString("N"));
                    try {
                        Directory.CreateDirectory(stage);ExtractPayload(stage);File.Copy(Application.ExecutablePath,Path.Combine(stage,"CodexMobileConnector.exe"));
                        RunUpgradeHelper(stage,false);
                    } finally {try{Directory.Delete(stage,true);}catch{}}
                } else {
                    Directory.CreateDirectory(root);ExtractPayload(root);File.Copy(Application.ExecutablePath,Path.Combine(root,"CodexMobileConnector.exe"),true);
                    File.WriteAllText(Path.Combine(root,"installed.json"),new JavaScriptSerializer().Serialize(new{root=root,version=1}));
                }
                if(ConnectorBootstrap.IsDefaultRoot(root)){ConnectorBootstrap.EnsureShortcut(root,true);Register();}
            });
            DesktopLocale.Save(root,chosenLanguage);
            if(!unattended)Process.Start(new ProcessStartInfo(Path.Combine(root,"CodexMobileConnector.exe"),"--install-root \""+root+"\""){UseShellExecute=true});Close();
        } catch(Exception error) {status.Text=(upgrading?DesktopLocale.T("升级"):DesktopLocale.T("安装"))+DesktopLocale.T("失败：")+DesktopLocale.Diagnostic(error.Message);install.Enabled=true;language.Enabled=true;if(unattended){File.WriteAllText(root+".install-error.txt",error.Message);Environment.ExitCode=1;Close();}}
    }
    void RunUpgradeHelper(string stage,bool recover) {
        string flags=recover?" -Recover":(Array.IndexOf(arguments,"--qa-upgrade-fail")>=0&&!ConnectorBootstrap.IsDefaultRoot(root)?" -QaFailAfterCopy":"")+(Array.IndexOf(arguments,"--qa-upgrade-abort")>=0&&!ConnectorBootstrap.IsDefaultRoot(root)?" -QaAbortAfterMove":"")+(Array.IndexOf(arguments,"--qa-upgrade-abort-committed")>=0&&!ConnectorBootstrap.IsDefaultRoot(root)?" -QaAbortCommitted":"");
        if(!recover&&Array.IndexOf(arguments,"--qa-upgrade-language-fail")>=0&&!ConnectorBootstrap.IsDefaultRoot(root))flags+=" -QaFailAfterLanguage";
        if(!recover&&Array.IndexOf(arguments,"--qa-upgrade-language-abort")>=0&&!ConnectorBootstrap.IsDefaultRoot(root))flags+=" -QaAbortAfterLanguage";
        var info=new ProcessStartInfo("powershell.exe","-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+Path.Combine(stage,"deploy","upgrade-connector.ps1")+"\" -Root \""+root+"\" -Stage \""+stage+"\" -Version \""+ConnectorBootstrap.Version+"\" -Language \""+DesktopLocale.Language+"\""+flags){UseShellExecute=false,CreateNoWindow=true,RedirectStandardError=true,RedirectStandardOutput=true};
        ConnectorBootstrap.ClearRuntimeOverrides(info);
        using(var process=Process.Start(info)){
            var output=process.StandardOutput.ReadToEndAsync();var error=process.StandardError.ReadToEndAsync();
            if(!process.WaitForExit(120000)){process.Kill();process.WaitForExit();throw new Exception(DesktopLocale.T("升级超时；再次运行安装包将恢复上次升级状态。"));}
            Task.WaitAll(output,error);if(process.ExitCode!=0)throw new Exception(DesktopLocale.Diagnostic((error.Result+" "+output.Result).Trim()));
        }
    }
    static void ExtractPayload(string destination) {
                using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")) {
                    if(stream==null)throw new Exception(DesktopLocale.T("安装包内容缺失。"));
                    using(var archive=new ZipArchive(stream,ZipArchiveMode.Read))foreach(var item in archive.Entries) {
                        var target=Path.GetFullPath(Path.Combine(destination,item.FullName));if(!target.StartsWith(Path.GetFullPath(destination)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception(DesktopLocale.T("安装包路径无效。"));
                        if(item.FullName.EndsWith("/")||item.FullName.EndsWith("\\")){Directory.CreateDirectory(target);continue;}
                        Directory.CreateDirectory(Path.GetDirectoryName(target));item.ExtractToFile(target,true);
                    }
                }
    }
    void Register() {using(var key=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexMobileConnector")){key.SetValue("DisplayName","Codex Mobile Bridge");key.SetValue("DisplayVersion",ConnectorBootstrap.Version);key.SetValue("InstallLocation",root);key.SetValue("UninstallString","\""+Path.Combine(root,"CodexMobileConnector.exe")+"\" --uninstall");key.SetValue("NoModify",1);key.SetValue("NoRepair",1);}}
}
