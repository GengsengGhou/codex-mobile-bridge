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
using Microsoft.Win32;

class ConnectorWindow : Form {
    readonly string root;
    readonly bool installed;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    TextBox domain = new TextBox(), name = new TextBox(), code = new TextBox();
    Label status = new Label(), details = new Label();
    Button primary = new Button(), retry = new Button(), open = new Button();
    CheckBox replace = new CheckBox();
    Timer timer = new Timer();
    bool busy, paired, watcherSubmitted;
    public string CapturePath;
    public bool Unattended;
    public ConnectorWindow(string destination) {
        root = destination;
        installed = string.Equals(Path.GetDirectoryName(Application.ExecutablePath), root, StringComparison.OrdinalIgnoreCase);
        Text = "Codex 手机桥接"; ClientSize = new Size(570, 490);
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
        primary.Click += async (s,e) => { if (!installed) await Install(); else await Pair(); };
        retry.Click += async (s,e) => await Connect();
        open.Click += (s,e) => { try { Process.Start("codex://"); } catch { MessageBox.Show(this,"请从 Windows 开始菜单打开 Codex。",Text); } };
        timer.Interval = 10000; timer.Tick += async (s,e) => { if (!busy && paired) await RefreshStatus(true); };
        Shown += async (s,e) => {
            if (installed) { await RefreshStatus(true); timer.Start(); }
            if(CapturePath!=null) {
                using(var bitmap=new Bitmap(Width,Height)) { DrawToBitmap(bitmap,new Rectangle(0,0,Width,Height)); bitmap.Save(CapturePath,System.Drawing.Imaging.ImageFormat.Png); }
            }
        };
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
    void Working(bool value) { busy=value; primary.Enabled=!value; retry.Enabled=!value && installed; replace.Enabled=!value; }
    async Task<Dictionary<string,object>> Run(object request) {
        return await Task.Run(() => {
            var start = new ProcessStartInfo(Path.Combine(root,"runtime","node.exe"), "\"" + Path.Combine(root,"scripts","connector-gui.mjs") + "\"") { WorkingDirectory=root, UseShellExecute=false, CreateNoWindow=true, RedirectStandardInput=true, RedirectStandardOutput=true, RedirectStandardError=true };
            start.EnvironmentVariables.Remove("CODEX_APP_TOOLS_PIPE_PATH");
            using (var p = Process.Start(start)) {
                p.StandardInput.Write(json.Serialize(request)); p.StandardInput.Close();
                var stdout = p.StandardOutput.ReadToEndAsync(); var stderr = p.StandardError.ReadToEndAsync();
                if (!p.WaitForExit(90000)) { p.Kill(); throw new Exception("连接超时，请打开 Codex 后重试。"); }
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
        try { await Run(new { action="pair", origin=origin, name=name.Text.Trim(), code=code.Text, replace=replace.Checked }); paired=true; watcherSubmitted=true; code.Clear(); replace.Checked=false; status.Text="已绑定，后台正在等待 Codex，可关闭此窗口。"; }
        catch(Exception e) { status.Text=e.Message; Working(false); return; }
        Working(false);
    }
    async Task Connect() {
        if (busy || !paired) return;
        Working(true); status.Text="正在连接 Codex…";
        try { await Run(new { action="connect" }); watcherSubmitted=true; status.Text="后台正在等待 Codex 和服务器，可关闭此窗口。"; }
        catch(Exception e) { status.Text="恢复启动失败："+e.Message; }
        Working(false);
    }
    async Task RefreshStatus(bool reconnect) {
        if (busy) return;
        Working(true);
        try {
            var data=await Run(new { action="status" }); paired=(bool)data["paired"];
            if (paired) {
                var state=Convert.ToString(data["state"]);
                if (!domain.Focused && !replace.Checked) domain.Text=Convert.ToString(data["origin"]);
                details.Text="设备：" + Convert.ToString(data["deviceId"]);
                status.Text=state=="online" || state=="connected" ? "已连接 Codex 和配对服务器" : "正在等待 Codex 或服务器连接";
                Working(false); if (reconnect && state=="waiting" && !watcherSubmitted) await Connect(); return;
            }
            status.Text="安装完成，请先登录网页获取配对码。";
        } catch(Exception e) { status.Text=e.Message; }
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
            Process.Start(new ProcessStartInfo(Path.Combine(root,"CodexMobileConnector.exe"), "--install-root \""+root+"\"") { UseShellExecute=true }); Close();
        } catch(Exception e) {
            status.Text="安装失败："+e.Message; Working(false);
            if(Unattended) { File.WriteAllText(root+".install-error.txt",e.Message); Environment.ExitCode=1; Close(); }
        }
    }
    static bool IsDefaultRoot(string path) { return string.Equals(path,Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexMobileConnector"),StringComparison.OrdinalIgnoreCase); }
    static void Register(string root) {
        using(var key=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")) {
            string command="\""+Path.Combine(root,"CodexMobileConnector.exe")+"\"";
            var old=key.GetValue("CodexMobileCompanion") as string;
            if(old!=null && old!=command) throw new Exception("登录启动项已被其他程序占用。");
            key.SetValue("CodexMobileCompanion",command);
        }
        using(var key=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexMobileConnector")) {
            key.SetValue("DisplayName","Codex 手机桥接"); key.SetValue("DisplayVersion","0.1.0");
            key.SetValue("InstallLocation",root); key.SetValue("UninstallString","\""+Path.Combine(root,"CodexMobileConnector.exe")+"\" --uninstall");
            key.SetValue("NoModify",1); key.SetValue("NoRepair",1);
        }
    }
    void Uninstall() {
        if (!installed) return;
        if(MessageBox.Show(this,"卸载应用和登录启动项？已保存的配对和本机数据将保留。",Text,MessageBoxButtons.OKCancel)!=DialogResult.OK) return;
        var info=new ProcessStartInfo("powershell.exe","-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \""+Path.Combine(root,"deploy","uninstall-connector.ps1")+"\" -Root \""+root+"\"") {UseShellExecute=false,CreateNoWindow=true};
        Process.Start(info); Close();
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
        var form=new ConnectorWindow(root);
        if(args.Length==4 && args[0]=="--install-root" && args[2]=="--capture") form.CapturePath=Path.GetFullPath(args[3]);
        if(args.Length==1 && args[0]=="--uninstall") form.Shown+=(s,e)=>form.Uninstall();
        if(args.Length==3 && args[0]=="--install-root" && args[2]=="--install") { form.Unattended=true; form.Shown+=async(s,e)=>await form.Install(); }
        Application.Run(form);
    }
}
