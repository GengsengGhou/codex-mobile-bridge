using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
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

[assembly: AssemblyVersion("0.1.7.0")]
[assembly: AssemblyFileVersion("0.1.7.0")]
[assembly: AssemblyInformationalVersion("0.1.7")]

// Keep setup and dependency recovery independent of WebView2 type loading.
static class ConnectorBootstrap {
    static string qaUninstallDecision,qaUninstallEvidence;
    [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern void SHChangeNotify(uint eventId,uint flags,string path,IntPtr item);
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
    public static void EnsureShortcut(string root) {
        if(!IsDefaultRoot(root))return;
        string executable=Path.Combine(root,"CodexMobileConnector.exe"),shortcut=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"Codex Mobile Connector.lnk");
        Directory.CreateDirectory(Path.GetDirectoryName(shortcut));
        dynamic shell=Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));dynamic link=shell.CreateShortcut(shortcut);
        if(File.Exists(shortcut)&&string.Equals((string)link.TargetPath,executable,StringComparison.OrdinalIgnoreCase)&&string.Equals((string)link.WorkingDirectory,root,StringComparison.OrdinalIgnoreCase)&&string.Equals(((string)link.IconLocation).Trim(),executable+",0",StringComparison.OrdinalIgnoreCase))return;
        link.TargetPath=executable;link.WorkingDirectory=root;link.Description="Codex 手机桥接与电脑配对";link.IconLocation=executable+",0";link.Save();
        SHChangeNotify(0x8000,0x0005,shortcut,IntPtr.Zero);
    }
    public static string ValidatedHub(string value) {
        Uri uri;
        if(string.IsNullOrWhiteSpace(value)||value.Length>2048||!Uri.TryCreate(value.Trim(),UriKind.Absolute,out uri)||uri.Scheme!="https"||uri.AbsolutePath!="/"||uri.Query!=""||uri.Fragment!=""||uri.UserInfo!=""||uri.HostNameType==UriHostNameType.Unknown) throw new Exception("请输入 HTTPS 服务器地址，不包含路径、账号或参数。");
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
        EnableDpiAwareness();Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        string root=Argument(args,"--install-root")??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexMobileConnector");
        root=Path.GetFullPath(root);
        if(!IsDefaultRoot(root)){qaUninstallDecision=Argument(args,"--qa-uninstall-decision");qaUninstallEvidence=Argument(args,"--qa-uninstall-evidence");}
        if(args.Length==1&&args[0]=="--tray")root=Path.GetDirectoryName(Application.ExecutablePath);
        bool installed=string.Equals(Path.GetDirectoryName(Application.ExecutablePath),root,StringComparison.OrdinalIgnoreCase), startup=Array.IndexOf(args,"--tray")>=0, uninstall=Array.IndexOf(args,"--uninstall")>=0;
        if(installed&&IsDefaultRoot(root))try{EnsureShortcut(root);}catch{}
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
            if(!installed)form=new InstallerWindow(root,Array.IndexOf(args,"--install")>=0);
            else if(uninstall)form=new UninstallWindow(root);
            else {
                try { form=InstalledWindow(root,args); }
                catch(Exception error) { form=new DependencyWindow(root,"连接器组件无法载入。请保留本机数据，卸载后重新安装。",error.GetType().Name);DependencyEvidence(form,root,args); }
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
        if(connector!=null&&!connector.BeginUninstall()){MessageBox.Show(dialog,"正在完成上一操作，请稍后卸载。","Codex 手机桥接",MessageBoxButtons.OK,MessageBoxIcon.Information);return false;}
        bool confirmed=qaUninstallDecision!=null&&!IsDefaultRoot(root)?qaUninstallDecision=="confirm":MessageBox.Show(dialog,"卸载应用和登录启动项？已保存的配对和本机数据将保留。","Codex 手机桥接",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)==DialogResult.OK;
        if(qaUninstallEvidence!=null&&!IsDefaultRoot(root))File.WriteAllText(qaUninstallEvidence,new JavaScriptSerializer().Serialize(new{confirmationReached=true,confirmed=confirmed,nativeConfirmationClickTested=false,webviewRequired=false}));
        if(!confirmed){if(connector!=null)connector.CancelUninstall();return false;}
        var info=new ProcessStartInfo("powershell.exe","-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \""+Path.Combine(root,"deploy","uninstall-connector.ps1")+"\" -Root \""+root+"\""){UseShellExecute=false,CreateNoWindow=true};
        try{Process.Start(info);if(connector!=null)connector.ExitForUninstall();else form.Close();return true;}catch(Exception error){if(connector!=null)connector.CancelUninstall();MessageBox.Show(dialog,error.Message,"无法启动卸载",MessageBoxButtons.OK,MessageBoxIcon.Warning);return false;}
    }
}
interface IConnectorWindow { void Wake();Form DialogOwner{get;}bool RecordUninstallIntent();bool BeginUninstall();void CancelUninstall();void ExitForUninstall(); }

class UninstallWindow : Form {
    public UninstallWindow(string root){Text="卸载 Codex 手机桥接";Icon=ConnectorBootstrap.BrandIcon();ClientSize=new Size(420,100);StartPosition=FormStartPosition.CenterScreen;BackColor=Color.White;Font=new Font("Microsoft YaHei UI",10);AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;Controls.Add(new Label{Text="Codex 手机桥接",Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleCenter});Shown+=(s,e)=>{ConnectorBootstrap.RequestUninstall(this,root);if(!IsDisposed)Close();};}
}

class DependencyWindow : Form {
    public DependencyWindow(string root,string message,string detail,Form owner=null) {
        Text="Codex 手机桥接";Icon=ConnectorBootstrap.BrandIcon();ClientSize=new Size(530,280);MinimumSize=new Size(480,300);StartPosition=FormStartPosition.CenterScreen;BackColor=Color.White;Font=new Font("Microsoft YaHei UI",10);AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;
        var body=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=1,Padding=new Padding(28),AutoScroll=true};Controls.Add(body);
        body.Controls.Add(new Label{Text="连接器需要 WebView2",Font=new Font(Font.FontFamily,15,FontStyle.Bold),AutoSize=true,Margin=new Padding(0,0,0,16)});
        body.Controls.Add(new Label{Text=message,AutoSize=true,MaximumSize=new Size(460,0),Margin=new Padding(0,0,0,10)});
        body.Controls.Add(new Label{Text=detail,AutoSize=true,ForeColor=Color.DimGray,MaximumSize=new Size(460,0),Margin=new Padding(0,0,0,18)});
        var actions=new FlowLayoutPanel{AutoSize=true,Dock=DockStyle.Top};body.Controls.Add(actions);
        var download=new Button{Text="安装 WebView2",AutoSize=true,Padding=new Padding(8)};download.Click+=(s,e)=>ConnectorBootstrap.Open("https://go.microsoft.com/fwlink/p/?LinkId=2124703");actions.Controls.Add(download);
        var retry=new Button{Text="重试",AutoSize=true,Padding=new Padding(8)};retry.Click+=(s,e)=>ConnectorBootstrap.Restart(root,this);actions.Controls.Add(retry);
        var folder=new Button{Text="打开安装目录",AutoSize=true,Padding=new Padding(8)};folder.Click+=(s,e)=>ConnectorBootstrap.Open(root);actions.Controls.Add(folder);
        var remove=new Button{Text="卸载",AutoSize=true,Padding=new Padding(8)};remove.Click+=(s,e)=>ConnectorBootstrap.RequestUninstall(owner??this,root);actions.Controls.Add(remove);
    }
}
class InstallerWindow : Form {
    readonly string root;readonly bool unattended;readonly Label status=new Label();readonly Button install=new Button();
    public InstallerWindow(string destination,bool silent) {
        root=destination;unattended=silent;Text="安装 Codex 手机桥接";Icon=ConnectorBootstrap.BrandIcon();ClientSize=new Size(550,300);MinimumSize=new Size(510,320);StartPosition=FormStartPosition.CenterScreen;BackColor=Color.White;Font=new Font("Microsoft YaHei UI",10);AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;
        var body=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=1,Padding=new Padding(30),AutoScroll=true};Controls.Add(body);
        body.Controls.Add(new Label{Text="Codex 手机桥接",AutoSize=true,Font=new Font(Font.FontFamily,18,FontStyle.Bold),Margin=new Padding(0,0,0,18)});
        body.Controls.Add(new Label{Text="仅为当前 Windows 用户安装",AutoSize=true,ForeColor=Color.DimGray,Margin=new Padding(0,0,0,10)});
        body.Controls.Add(new Label{Text=root,AutoSize=true,MaximumSize=new Size(480,0),ForeColor=Color.DimGray,Margin=new Padding(0,0,0,20)});
        status.AutoSize=true;status.MaximumSize=new Size(480,0);status.Margin=new Padding(0,0,0,16);body.Controls.Add(status);
        install.Text="安装";install.AutoSize=true;install.Padding=new Padding(20,7,20,7);install.BackColor=Color.FromArgb(20,100,71);install.ForeColor=Color.White;install.FlatStyle=FlatStyle.Flat;install.FlatAppearance.BorderSize=0;body.Controls.Add(install);
        install.Click+=async(s,e)=>await Install();if(unattended)Shown+=async(s,e)=>await Install();
    }
    public async Task Install() {
        install.Enabled=false;status.Text="正在安装应用和运行环境…";
        try {
            await Task.Run(()=>{
                if(Directory.Exists(root))foreach(var item in Directory.GetFileSystemEntries(root))if(Path.GetFileName(item)!=".local")throw new Exception("已存在安装，请打开现有程序，或保留数据卸载后重新安装。");
                Directory.CreateDirectory(root);
                using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")) {
                    if(stream==null)throw new Exception("安装包内容缺失。");
                    using(var archive=new ZipArchive(stream,ZipArchiveMode.Read))foreach(var item in archive.Entries) {
                        var target=Path.GetFullPath(Path.Combine(root,item.FullName));if(!target.StartsWith(Path.GetFullPath(root)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("安装包路径无效。");
                        if(item.FullName.EndsWith("/")||item.FullName.EndsWith("\\")){Directory.CreateDirectory(target);continue;}
                        Directory.CreateDirectory(Path.GetDirectoryName(target));item.ExtractToFile(target,true);
                    }
                }
                File.Copy(Application.ExecutablePath,Path.Combine(root,"CodexMobileConnector.exe"),true);
                if(ConnectorBootstrap.IsDefaultRoot(root)){ConnectorBootstrap.EnsureShortcut(root);Register();}
                File.WriteAllText(Path.Combine(root,"installed.json"),new JavaScriptSerializer().Serialize(new{root=root,version=1}));
            });
            if(!unattended)Process.Start(new ProcessStartInfo(Path.Combine(root,"CodexMobileConnector.exe"),"--install-root \""+root+"\""){UseShellExecute=true});Close();
        } catch(Exception error) {status.Text="安装失败："+error.Message;install.Enabled=true;if(unattended){File.WriteAllText(root+".install-error.txt",error.Message);Environment.ExitCode=1;Close();}}
    }
    void Register() {using(var key=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexMobileConnector")){key.SetValue("DisplayName","Codex 手机桥接");key.SetValue("DisplayVersion",ConnectorBootstrap.Version);key.SetValue("InstallLocation",root);key.SetValue("UninstallString","\""+Path.Combine(root,"CodexMobileConnector.exe")+"\" --uninstall");key.SetValue("NoModify",1);key.SetValue("NoRepair",1);}}
}
