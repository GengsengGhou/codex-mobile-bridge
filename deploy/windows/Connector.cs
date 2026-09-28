using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Threading;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

class ConnectorWindow : Form {
    readonly string root;
    readonly bool installed;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    TextBox domain = new TextBox(), name = new TextBox(), code = new TextBox();
    Label status = new Label(), details = new Label();
    Button primary = new Button(), retry = new Button(), open = new Button();
    CheckBox replace = new CheckBox();
    System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    bool busy, paired, watcherSubmitted, paused, exiting, stopping, updatingAuto;
    NotifyIcon tray;
    ToolStripMenuItem trayStatus, trayConnect, trayDisconnect, trayAuto;
    CheckBox autoStart = new CheckBox();
    public bool TrayStartup;
    public bool UninstallMode;
    public string LifecycleEvidence;
    int uninstallRequests;
    int actionEpoch;
    public string CapturePath;
    public bool Unattended;
    public ConnectorWindow(string destination) {
        root = destination;
        installed = string.Equals(Path.GetDirectoryName(Application.ExecutablePath), root, StringComparison.OrdinalIgnoreCase);
        Text = "Codex 手机桥接"; ClientSize = new Size(570, 490);
        Icon = SystemIcons.Application;
        MinimumSize = new Size(586, 529); MaximumSize = new Size(586, 529);
        StartPosition = FormStartPosition.CenterScreen; BackColor = Color.FromArgb(248,249,250);
        Font = new Font("Segoe UI", 10); AutoScaleMode = AutoScaleMode.Dpi;
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开安装目录",null,(s,e)=>Process.Start(root));
        menu.Items.Add("卸载（保留配对数据）",null,(s,e)=>Uninstall());
        var settings = new Button { Text="设置", Location=new Point(430,28), Size=new Size(95,29) };
        settings.Click += (s,e)=>menu.Show(settings,new Point(0,settings.Height)); Controls.Add(settings);
        var title = new Label { Text = "Codex 手机桥接", Font = new Font("Segoe UI", 17, FontStyle.Bold), Location = new Point(28,23), Size = new Size(395,40) };
        Controls.Add(title);
        status.Location = new Point(30,78); status.Size = new Size(510,30); status.ForeColor = Color.FromArgb(24,105,67);
        status.Text = installed ? "正在检查这台电脑…" : "安装到当前 Windows 用户"; Controls.Add(status);
        Controls.Add(new Label {Text="1. 登录网页，在设备页生成配对码\n2. 粘贴配对码，绑定这台电脑",Location=new Point(30,112),Size=new Size(495,42),ForeColor=Color.DimGray});
        Field("HTTPS 服务器", domain, 160); domain.Width=305;
        var hub = new Button { Text="网页登录 / 获取配对码",Location=new Point(350,182),Size=new Size(175,32) }; Controls.Add(hub);
        hub.Click+=(s,e)=>{try{Process.Start(ValidatedHub(domain.Text));}catch(Exception error){status.Text=error.Message;}};
        Field("设备名称", name, 224); name.Text = Environment.MachineName;
        Field("配对码", code, 288); code.UseSystemPasswordChar = true;
        replace.Text = "将现有配对替换为此服务器"; replace.Location = new Point(30,354); replace.Size = new Size(490,25); Controls.Add(replace);
        primary.Text = installed ? "绑定这台电脑" : "安装"; primary.Location = new Point(30,393); primary.Size = new Size(155,36); Controls.Add(primary);
        retry.Text = "重试连接"; retry.Location = new Point(200,393); retry.Size = new Size(155,36); retry.Enabled = installed; Controls.Add(retry);
        open.Text = "打开 Codex"; open.Location = new Point(370,393); open.Size = new Size(155,36); Controls.Add(open);
        details.Location = new Point(30,444); details.Size = new Size(510,35); details.ForeColor = Color.DimGray;
        details.Text = installed ? "仅当前 Windows 用户" : "无需管理员权限"; Controls.Add(details);
        autoStart.Text="Windows 登录后自动连接"; autoStart.Location=new Point(30,470); autoStart.Size=new Size(490,25); autoStart.Visible=installed; Controls.Add(autoStart);
        ClientSize=new Size(570,510); MinimumSize=new Size(586,549); MaximumSize=new Size(586,549);
        autoStart.CheckedChanged += async(s,e)=> { if(updatingAuto || !installed) return; string failure=null; try { await Run(new { action="autostart", enabled=autoStart.Checked }); trayAuto.Checked=autoStart.Checked; } catch(Exception error) {failure=error.Message;} if(failure!=null) {await RefreshStatus(false);status.Text=failure;} };
        var trayMenu=new ContextMenuStrip();
        trayStatus=new ToolStripMenuItem("正在检查连接") {Enabled=false}; trayMenu.Items.Add(trayStatus);
        trayMenu.Items.Add("显示窗口",null,(s,e)=>Wake());
        trayConnect=new ToolStripMenuItem("连接",null,async(s,e)=>await Connect()); trayMenu.Items.Add(trayConnect);
        trayDisconnect=new ToolStripMenuItem("断开连接",null,async(s,e)=>await Disconnect(false)); trayMenu.Items.Add(trayDisconnect);
        trayAuto=new ToolStripMenuItem("Windows 登录后自动连接") {CheckOnClick=true};
        trayAuto.Click+=(s,e)=>{autoStart.Checked=trayAuto.Checked;}; trayMenu.Items.Add(trayAuto);
        trayMenu.Items.Add(new ToolStripSeparator()); trayMenu.Items.Add("退出",null,async(s,e)=>await Disconnect(true));
        tray=new NotifyIcon {Icon=SystemIcons.Application,Text="Codex 手机桥接",ContextMenuStrip=trayMenu,Visible=installed};
        tray.DoubleClick+=(s,e)=>Wake();
        FormClosing+=(s,e)=>{
            if(e.CloseReason==CloseReason.WindowsShutDown || e.CloseReason==CloseReason.TaskManagerClosing){exiting=true;timer.Stop();tray.Visible=false;return;}
            if(installed && !exiting && CapturePath==null){e.Cancel=true;Hide();}
        };
        FormClosed+=(s,e)=>{timer.Stop();tray.Dispose();};
        primary.Click += async (s,e) => { if (!installed) await Install(); else await Pair(); };
        retry.Click += async (s,e) => await Connect();
        open.Click += (s,e) => { try { Process.Start("codex://"); } catch { MessageBox.Show(this,"请从 Windows 开始菜单打开 Codex。",Text); } };
        timer.Interval = 3000; timer.Tick += async (s,e) => { if (!busy && !stopping) await RefreshStatus(false); };
        Shown += async (s,e) => {
            if(UninstallMode) return;
            if(LifecycleEvidence!=null){await VerifyLifecycle();return;}
            if (installed) {
                bool initialized=true;
                if(CapturePath==null) {try{await Run(new { action="initialize" });}catch(Exception error){initialized=false;status.Text=error.Message;}}
                await RefreshStatus(false);
                if(CapturePath==null && paired && initialized) await Connect(TrayStartup ? "startup" : "manual");
                if(TrayStartup && paused){exiting=true;Close();return;}
                timer.Start(); if(TrayStartup) Hide();
            }
            if(CapturePath!=null) {
                using(var bitmap=new Bitmap(Width,Height)) { DrawToBitmap(bitmap,new Rectangle(0,0,Width,Height)); bitmap.Save(CapturePath,System.Drawing.Imaging.ImageFormat.Png); }
            }
        };
    }
    public void Wake() {
        if(IsDisposed || exiting) return;
        Show(); WindowState=FormWindowState.Normal; Activate();
    }
    async Task VerifyLifecycle() {
        var evidence=new Dictionary<string,object>();
        try {
            await RefreshStatus(false);
            Close(); evidence["windowCloseHides"]=!Visible && !IsDisposed; evidence["trayRemainsVisible"]=tray.Visible;
            Wake(); evidence["showWindowPreservesPause"]=Visible && paused;
            Hide();
            using(var second=Process.Start(new ProcessStartInfo(Application.ExecutablePath,"--install-root \""+root+"\""){UseShellExecute=false,CreateNoWindow=true})) { await Task.Run(()=>second.WaitForExit(5000)); evidence["secondManualInstanceExits"]=second.HasExited; }
            await Task.Delay(300); evidence["secondManualInstanceShowsOwner"]=Visible && paused;
            Hide();
            using(var second=Process.Start(new ProcessStartInfo(Application.ExecutablePath,"--install-root \""+root+"\" --tray"){UseShellExecute=false,CreateNoWindow=true})) { await Task.Run(()=>second.WaitForExit(5000)); evidence["secondStartupInstanceExits"]=second.HasExited; }
            await Task.Delay(300); evidence["secondStartupDoesNotShow"]=!Visible && paused;
            using(var second=Process.Start(new ProcessStartInfo(Application.ExecutablePath,"--install-root \""+root+"\" --uninstall"){UseShellExecute=false,CreateNoWindow=true})) { await Task.Run(()=>second.WaitForExit(5000)); evidence["uninstallSecondInstanceExits"]=second.HasExited; }
            await Task.Delay(300); evidence["uninstallIntentDelivered"]=uninstallRequests==1;
            await Disconnect(false); evidence["disconnectConfirmed"]=paused && status.Text=="连接已断开";
            evidence["nativeTrayClicksTested"]=false;
            File.WriteAllText(LifecycleEvidence,json.Serialize(evidence));
            await Disconnect(true);
        } catch(Exception error) {evidence["error"]=error.Message;File.WriteAllText(LifecycleEvidence,json.Serialize(evidence));exiting=true;Close();}
    }
    public static string ValidatedHub(string value) {
        Uri uri;
        if(!Uri.TryCreate(value.Trim(),UriKind.Absolute,out uri) || uri.Scheme!="https" || uri.AbsolutePath!="/" || uri.Query!="" || uri.Fragment!="" || uri.UserInfo!="") throw new Exception("请输入 HTTPS 服务器地址，不包含路径、账号或参数。");
        return uri.GetLeftPart(UriPartial.Authority)+"/";
    }
    void Field(string label, TextBox input, int top) {
        Controls.Add(new Label { Text = label, Location = new Point(30,top), Size = new Size(490,23) });
        input.Location = new Point(30,top+25); input.Size = new Size(495,28); Controls.Add(input);
    }
    void Working(bool value) { busy=value; primary.Enabled=!value && !stopping; retry.Enabled=!value && installed && !stopping; replace.Enabled=!value && !stopping; trayConnect.Enabled=!value && paired && !stopping; trayDisconnect.Enabled=installed && !stopping; }
    async Task<Dictionary<string,object>> Run(object request) {
        return await Task.Run(() => {
            var start = new ProcessStartInfo(Path.Combine(root,"runtime","node.exe"), "\"" + Path.Combine(root,"scripts","connector-gui.mjs") + "\"") { WorkingDirectory=root, UseShellExecute=false, CreateNoWindow=true, RedirectStandardInput=true, RedirectStandardOutput=true, RedirectStandardError=true };
            start.EnvironmentVariables.Remove("CODEX_APP_TOOLS_PIPE_PATH");
            using (var p = Process.Start(start)) {
                p.StandardInput.Write(json.Serialize(request)); p.StandardInput.Close();
                var stdout = p.StandardOutput.ReadToEndAsync(); var stderr = p.StandardError.ReadToEndAsync();
                if (!p.WaitForExit(30000)) { p.Kill(); throw new Exception("操作超时，请重试并核对连接状态。"); }
                Task.WaitAll(stdout,stderr);
                var result=json.Deserialize<Dictionary<string,object>>(stdout.Result.Trim());
                if (!(bool)result["ok"]) throw new Exception(Convert.ToString(result["error"]));
                return result;
            }
        });
    }
    async Task Pair() {
        string origin;
        try { origin=ValidatedHub(domain.Text); } catch(Exception e) {status.Text=e.Message;return;}
        if (string.IsNullOrWhiteSpace(name.Text) || code.Text.Length!=43) { status.Text="请输入设备名称和网页生成的 43 位配对码。"; return; }
        if (paired && !replace.Checked) { status.Text="如需更换服务器，请勾选替换现有配对。"; return; }
        if (paired && MessageBox.Show(this,"新服务器验证配对码后，替换这台电脑的配对？请随后在原网页中撤销旧设备。",Text,MessageBoxButtons.OKCancel)!=DialogResult.OK) return;
        Working(true); status.Text="正在验证配对码…";
        int epoch=++actionEpoch;
        try { var data=await Run(new { action="pair", origin=origin, name=name.Text.Trim(), code=code.Text, replace=replace.Checked }); paired=true; code.Clear(); replace.Checked=false; if(epoch==actionEpoch) {paused=data.ContainsKey("paused") && (bool)data["paused"]; watcherSubmitted=!paused; status.Text=paused ? "已绑定，连接已暂停" : "已绑定，后台正在等待 Codex，可关闭此窗口。";} }
        catch(Exception e) { if(epoch==actionEpoch)status.Text=e.Message; Working(false); return; }
        Working(false);
    }
    async Task Connect(string reason="manual") {
        if (busy || stopping) return;
        Working(true); status.Text="正在连接 Codex…";
        int epoch=++actionEpoch;
        try { var data=await Run(new { action="connect", reason=reason }); if(epoch==actionEpoch){paused=data.ContainsKey("paused") && (bool)data["paused"]; watcherSubmitted=!paused; status.Text=paused ? "连接已暂停" : "后台正在等待 Codex 和服务器，可关闭此窗口。";} }
        catch(Exception e) { if(epoch==actionEpoch)status.Text="恢复启动失败："+e.Message; }
        Working(false);
    }
    async Task Disconnect(bool quit) {
        if(stopping || exiting) return;
        ++actionEpoch;
        stopping=true; Working(busy); status.Text="正在断开连接…"; trayStatus.Text=status.Text;
        try {
            var data=await Run(new { action=quit ? "quit" : "disconnect" });
            if(!(bool)data["paused"] || !(bool)data["disconnectVerified"]) throw new Exception("连接状态已被另一操作修改，请重新断开。");
            paused=true; watcherSubmitted=false; status.Text="连接已断开"; trayStatus.Text=status.Text;
            if(quit){exiting=true;tray.Visible=false;Close();return;}
        } catch(Exception error){status.Text="未能确认断开："+error.Message;trayStatus.Text="断开未确认";}
        stopping=false; Working(busy);
    }
    async Task RefreshStatus(bool reconnect) {
        if (busy) return;
        int epoch=actionEpoch;
        Working(true);
        try {
            var data=await Run(new { action="status" });
            if(epoch!=actionEpoch){Working(false);return;}
            paired=(bool)data["paired"];
            paused=(bool)data["paused"]; updatingAuto=true; autoStart.Checked=(bool)data["autoStart"]; trayAuto.Checked=autoStart.Checked; updatingAuto=false;
            if (paired) {
                var state=Convert.ToString(data["state"]);
                if (!domain.Focused && !replace.Checked) domain.Text=Convert.ToString(data["origin"]);
                details.Text="设备：" + Convert.ToString(data["deviceId"]);
                if(!stopping) status.Text=state=="paused" ? "连接已断开" : state=="stopping" ? "连接已暂停，断开尚未确认" : state=="online" || state=="connected" ? "已连接 Codex 和配对服务器" : "正在等待 Codex 或服务器连接";
                trayStatus.Text=status.Text; tray.Text=status.Text.Length>63 ? status.Text.Substring(0,63) : status.Text;
                Working(false); return;
            }
            status.Text="安装完成，请先登录网页获取配对码。";
        } catch(Exception e) { if(epoch==actionEpoch){status.Text=e.Message;trayStatus.Text="连接状态读取失败";tray.Text=trayStatus.Text;} }
        Working(false);
    }
    async Task Install() {
        Working(true); status.Text="正在安装应用和运行环境…";
        try {
            await Task.Run(() => {
                if(Directory.Exists(root)) foreach(var item in Directory.GetFileSystemEntries(root)) {
                    if(Path.GetFileName(item)!=".local") throw new Exception("已存在安装，请打开现有程序，或保留数据卸载后重新安装。");
                }
                Directory.CreateDirectory(root);
                using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")) {
                    if(stream==null) throw new Exception("安装包内容缺失。");
                    using(var archive=new ZipArchive(stream,ZipArchiveMode.Read)) foreach(var item in archive.Entries) {
                        var target=Path.GetFullPath(Path.Combine(root,item.FullName));
                        if(!target.StartsWith(Path.GetFullPath(root)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)) throw new Exception("安装包路径无效。");
                        if(item.FullName.EndsWith("/") || item.FullName.EndsWith("\\")) { Directory.CreateDirectory(target); continue; }
                        Directory.CreateDirectory(Path.GetDirectoryName(target)); item.ExtractToFile(target,true);
                    }
                }
                File.Copy(Application.ExecutablePath,Path.Combine(root,"CodexMobileConnector.exe"),true);
                if(IsDefaultRoot(root)) { Shortcut(root); Register(root); }
                File.WriteAllText(Path.Combine(root,"installed.json"),json.Serialize(new { root=root, version=1 }));
            });
            if(!Unattended) Process.Start(new ProcessStartInfo(Path.Combine(root,"CodexMobileConnector.exe"), "--install-root \""+root+"\"") { UseShellExecute=true }); exiting=true; Close();
        } catch(Exception e) {
            status.Text="安装失败："+e.Message; Working(false);
            if(Unattended) { File.WriteAllText(root+".install-error.txt",e.Message); Environment.ExitCode=1; Close(); }
        }
    }
    static bool IsDefaultRoot(string path) { return string.Equals(path,Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexMobileConnector"),StringComparison.OrdinalIgnoreCase); }
    static void Register(string root) {
        using(var key=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexMobileConnector")) {
            key.SetValue("DisplayName","Codex 手机桥接"); key.SetValue("DisplayVersion","0.1.1");
            key.SetValue("InstallLocation",root); key.SetValue("UninstallString","\""+Path.Combine(root,"CodexMobileConnector.exe")+"\" --uninstall");
            key.SetValue("NoModify",1); key.SetValue("NoRepair",1);
        }
    }
    public void Uninstall() {
        if(LifecycleEvidence!=null){uninstallRequests++;return;}
        if (!installed) return;
        if(MessageBox.Show(this,"卸载应用和登录启动项？已保存的配对和本机数据将保留。",Text,MessageBoxButtons.OKCancel)!=DialogResult.OK) return;
        var info=new ProcessStartInfo("powershell.exe","-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \""+Path.Combine(root,"deploy","uninstall-connector.ps1")+"\" -Root \""+root+"\"") {UseShellExecute=false,CreateNoWindow=true};
        Process.Start(info); exiting=true; Close();
    }
    static void Shortcut(string root) {
        var shell=Type.GetTypeFromProgID("WScript.Shell");
        dynamic obj=Activator.CreateInstance(shell);
        dynamic link=obj.CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"Codex Mobile Connector.lnk"));
        link.TargetPath=Path.Combine(root,"CodexMobileConnector.exe"); link.WorkingDirectory=root; link.Description="Codex 手机桥接与电脑配对"; link.Save();
    }
    [STAThread] static void Main(string[] args) {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        string root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexMobileConnector");
        // QA overrides the destination only; production never receives credentials in arguments.
        if(args.Length>=2 && args[0]=="--install-root") root=Path.GetFullPath(args[1]);
        if(args.Length==1 && args[0]=="--tray") root=Path.GetDirectoryName(Application.ExecutablePath);
        bool installed=string.Equals(Path.GetDirectoryName(Application.ExecutablePath),root,StringComparison.OrdinalIgnoreCase);
        bool startup=Array.IndexOf(args,"--tray")>=0;
        bool uninstall=Array.IndexOf(args,"--uninstall")>=0;
        string identity;
        using(var sha=SHA256.Create()) identity=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()+"|"+WindowsIdentity.GetCurrent().User.Value))).Replace("-","");
        if(!installed)identity+="-setup-"+Process.GetCurrentProcess().Id;
        bool owner=true;
        using(var mutex=new Mutex(true,@"Global\CodexMobileCompanion-"+identity,out owner))
        using(var wake=new EventWaitHandle(false,EventResetMode.AutoReset,@"Global\CodexMobileCompanionWake-"+identity))
        using(var remove=new EventWaitHandle(false,EventResetMode.AutoReset,@"Global\CodexMobileCompanionUninstall-"+identity)) {
        if(installed && !owner){if(uninstall)remove.Set();else if(!startup)wake.Set();return;}
        var form=new ConnectorWindow(root);
        form.TrayStartup=startup;
        form.UninstallMode=uninstall;
        if(args.Length==4 && args[0]=="--install-root" && args[2]=="--capture") form.CapturePath=Path.GetFullPath(args[3]);
        if(args.Length==4 && args[0]=="--install-root" && args[2]=="--qa-lifecycle" && !IsDefaultRoot(root)) form.LifecycleEvidence=Path.GetFullPath(args[3]);
        if(uninstall) form.Shown+=(s,e)=>form.Uninstall();
        if(args.Length==3 && args[0]=="--install-root" && args[2]=="--install") { form.Unattended=true; form.Shown+=async(s,e)=>await form.Install(); }
        if(installed) Task.Run(()=>{while(!form.IsDisposed){int action=WaitHandle.WaitAny(new WaitHandle[]{wake,remove},1000);if(action<2 && form.IsHandleCreated && !form.IsDisposed) try{form.BeginInvoke(action==0 ? new Action(form.Wake) : new Action(form.Uninstall));}catch(InvalidOperationException){}}});
        Application.Run(form);
        if(owner)mutex.ReleaseMutex();
        }
    }
}
