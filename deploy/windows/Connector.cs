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

[assembly: AssemblyVersion("0.1.4.0")]
[assembly: AssemblyFileVersion("0.1.4.0")]
[assembly: AssemblyInformationalVersion("0.1.4")]

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
    TextBox information = new TextBox();
    TableLayoutPanel pairingPanel, legacyPanel, summaryPanel, settingsPanel;
    Label computerValue = new Label(), serverValue = new Label(), stateDescription = new Label();
    Button hub = new Button(), settingsButton = new Button(), legacyButton = new Button();
    Button cancelPairing = new Button();
    TableLayoutPanel statePanel;
    TableLayoutPanel pairingInput;
    Label pairingTarget=new Label();
    Label connectionPreference=new Label();
    Label settingsFeedback=new Label();
    string actionWarning;
    PictureBox stateIcon = new PictureBox();
    ToolTip tips = new ToolTip();
    bool changingServer, settingsVisible;
    readonly Dictionary<string,Image> glyphs=new Dictionary<string,Image>();
    public bool TrayStartup;
    public bool UninstallMode;
    public string LifecycleEvidence;
    public string StatusEvidence;
    int uninstallRequests;
    int actionEpoch;
    bool statusReadSucceeded;
    public string CapturePath;
    public bool Unattended;
    public ConnectorWindow(string destination) {
        root = destination;
        installed = string.Equals(Path.GetDirectoryName(Application.ExecutablePath), root, StringComparison.OrdinalIgnoreCase);
        BuildView();
        autoStart.CheckedChanged += async(s,e)=> {
            if(updatingAuto || !installed || busy || stopping)return;
            bool enabled=autoStart.Checked;string failure=null;Working(true);settingsFeedback.Text="";
            try {await Run(new {action="autostart",enabled=enabled});trayAuto.Checked=enabled;}
            catch(Exception error){failure=error.Message;}
            finally {Working(false);}
            await RefreshStatus(false);settingsFeedback.Text=failure??"";settingsFeedback.Visible=failure!=null;
        };
        var trayMenu=new ContextMenuStrip();
        trayStatus=new ToolStripMenuItem("正在检查连接") {Enabled=false}; trayMenu.Items.Add(trayStatus);
        trayMenu.Items.Add("显示窗口",null,(s,e)=>Wake());
        trayConnect=new ToolStripMenuItem("连接",null,async(s,e)=>await Connect()); trayMenu.Items.Add(trayConnect);
        trayDisconnect=new ToolStripMenuItem("断开连接",null,async(s,e)=>await Disconnect(false)); trayMenu.Items.Add(trayDisconnect);
        trayAuto=new ToolStripMenuItem("Windows 登录后自动连接") {CheckOnClick=true};
        trayAuto.Click+=(s,e)=>{autoStart.Checked=trayAuto.Checked;}; trayMenu.Items.Add(trayAuto);
        trayMenu.Items.Add(new ToolStripSeparator()); trayMenu.Items.Add("退出",null,async(s,e)=>await Disconnect(true));
        tray=new NotifyIcon {Icon=Icon,Text="Codex 手机桥接",ContextMenuStrip=trayMenu,Visible=installed};
        tray.DoubleClick+=(s,e)=>Wake();
        FormClosing+=(s,e)=>{
            if(e.CloseReason==CloseReason.WindowsShutDown || e.CloseReason==CloseReason.TaskManagerClosing){exiting=true;timer.Stop();tray.Visible=false;return;}
            if(installed && !exiting && CapturePath==null){e.Cancel=true;Hide();}
        };
        FormClosed+=(s,e)=>{timer.Stop();tray.Dispose();tips.Dispose();foreach(var image in glyphs.Values)image.Dispose();};
        primary.Click += async (s,e) => { if (!installed) await Install(); else await Pair(); };
        retry.Click += async (s,e) => { if(actionWarning!=null)await Connect();else if(!statusReadSucceeded) await RefreshStatus(false); else if(paused) await Connect(); else await Disconnect(false); };
        open.Click += (s,e) => { try { Process.Start("codex://"); } catch { MessageBox.Show(this,"请从 Windows 开始菜单打开 Codex。",Text); } };
        timer.Interval = 3000; timer.Tick += async (s,e) => { if (!busy && !stopping) await RefreshStatus(false); };
        Shown += async (s,e) => {
            if(UninstallMode) return;
            if(LifecycleEvidence!=null){await VerifyLifecycle();return;}
            if(StatusEvidence!=null){await RefreshStatus(false);File.WriteAllText(StatusEvidence,json.Serialize(new {paired=paired,paused=paused,windowStatus=status.Text,trayStatus=trayStatus.Text,trayTooltip=tray.Text,statusReadSucceeded=statusReadSucceeded,retryEnabled=retry.Enabled,connectMenuEnabled=trayConnect.Enabled}));exiting=true;Close();return;}
            if (installed) {
                bool initialized=true;
                if(CapturePath==null) {try{await Run(new { action="initialize",reason="view" });}catch(Exception error){initialized=false;SetStatus(error.Message);}}
                await RefreshStatus(false);
                if(CapturePath==null&&TrayStartup&&initialized&&paired){await Connect("startup");await RefreshStatus(false);}
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
    TableLayoutPanel Stack() { return new TableLayoutPanel {ColumnCount=1,AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,Dock=DockStyle.Top,Margin=Padding.Empty,Padding=Padding.Empty}; }
    Label Caption(string text) { return new Label {Text=text,AutoSize=true,ForeColor=Color.FromArgb(101,114,114),Margin=new Padding(0,0,0,4)}; }
    Image Glyph(string glyph,int size) {
        if(string.IsNullOrEmpty(glyph))return null;
        using(var graphics=CreateGraphics())size=(int)Math.Round(size*graphics.DpiX/96f);
        string key=glyph+"/"+size;Image cached;if(glyphs.TryGetValue(key,out cached))return cached;
        var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("icons."+glyph+".png");
        if(stream==null) {var path=Path.Combine(root,"deploy","windows","icons",glyph+".png");if(File.Exists(path))stream=File.OpenRead(path);}
        if(stream==null)return null;
        using(stream)using(var source=Image.FromStream(stream)){var bitmap=new Bitmap(source,new Size(size,size));glyphs[key]=bitmap;return bitmap;}
    }
    Icon BrandIcon() { var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("icons.connector.ico");if(stream!=null)using(stream)return new Icon(stream);return Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
    void StyleButton(Button button,string text,string glyph,bool accent) {
        button.Text=text;button.AccessibleName=text;button.FlatStyle=FlatStyle.Flat;button.FlatAppearance.BorderSize=accent?0:1;button.FlatAppearance.BorderColor=Color.FromArgb(220,228,228);button.BackColor=accent?Color.FromArgb(206,244,227):Color.White;button.ForeColor=Color.FromArgb(28,53,45);button.Padding=new Padding(10,6,10,6);button.Cursor=Cursors.Hand;button.TextImageRelation=TextImageRelation.ImageBeforeText;button.ImageAlign=ContentAlignment.MiddleLeft;button.Image=Glyph(glyph,18);button.UseVisualStyleBackColor=false;button.Margin=new Padding(0,0,0,10);
    }
    void AddSummary(string caption,Label value) {var row=new TableLayoutPanel {AutoSize=true,Dock=DockStyle.Top,ColumnCount=2,Padding=new Padding(16,7,16,7),Margin=Padding.Empty};row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,88));row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));row.Controls.Add(Caption(caption),0,0);value.AutoSize=true;value.MaximumSize=new Size(350,0);row.Controls.Add(value,1,0);summaryPanel.Controls.Add(row);}
    void Field(string label,TextBox input,TableLayoutPanel target) {target.Controls.Add(Caption(label));input.Dock=DockStyle.Top;input.Margin=new Padding(0,3,0,12);input.BorderStyle=BorderStyle.FixedSingle;input.AccessibleName=label;target.Controls.Add(input);}
    void BuildView() {
        Text="Codex 手机桥接";ClientSize=new Size(560,420);MinimumSize=new Size(540,440);Icon=BrandIcon();StartPosition=FormStartPosition.CenterScreen;BackColor=Color.White;Font=new Font("Microsoft YaHei UI",9);AutoScaleMode=AutoScaleMode.Dpi;
        var layout=Stack();layout.Dock=DockStyle.Fill;layout.AutoSize=false;layout.AutoScroll=true;layout.Padding=new Padding(28,22,28,20);Controls.Add(layout);
        var header=new TableLayoutPanel {Dock=DockStyle.Top,Height=58,ColumnCount=3,Margin=new Padding(0,0,0,20)};header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,44));header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,40));header.Controls.Add(new PictureBox {Image=Glyph("smartphone",30),SizeMode=PictureBoxSizeMode.CenterImage,Dock=DockStyle.Fill},0,0);
        var brand=Stack();brand.Controls.Add(new Label {Text="Codex 手机桥接",Font=new Font(Font.FontFamily,16,FontStyle.Bold),AutoSize=true,Margin=new Padding(0,0,0,4)});brand.Controls.Add(new Label {Text="Mobile Connector",ForeColor=Color.FromArgb(105,116,116),AutoSize=true});header.Controls.Add(brand,1,0);StyleButton(settingsButton,"","settings",false);settingsButton.Size=new Size(38,38);settingsButton.AccessibleName="设置";tips.SetToolTip(settingsButton,"设置");settingsButton.Click+=(s,e)=>{settingsVisible=!settingsVisible;UpdateView();};header.Controls.Add(settingsButton,2,0);layout.Controls.Add(header);
        var state=new TableLayoutPanel {AutoSize=true,Dock=DockStyle.Top,ColumnCount=2,Margin=new Padding(0,0,0,22)};state.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,40));state.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));stateIcon.Image=Glyph("plug",26);stateIcon.SizeMode=PictureBoxSizeMode.CenterImage;stateIcon.Size=new Size(34,36);state.Controls.Add(stateIcon,0,0);
        var stateText=Stack();status.AutoSize=true;status.MaximumSize=new Size(430,0);status.Font=new Font(Font.FontFamily,13,FontStyle.Bold);status.Text=installed?"正在检查连接":"连接手机与这台电脑";status.Margin=new Padding(0,0,0,7);stateText.Controls.Add(status);stateDescription.AutoSize=true;stateDescription.MaximumSize=new Size(430,0);stateDescription.ForeColor=Color.FromArgb(105,116,116);stateDescription.Text=installed?"":"Codex Mobile Connector";stateText.Controls.Add(stateDescription);state.Controls.Add(stateText,1,0);layout.Controls.Add(state);
        statePanel=state;
        summaryPanel=Stack();summaryPanel.Padding=new Padding(0,12,0,16);summaryPanel.Margin=new Padding(0,0,0,14);summaryPanel.BackColor=Color.FromArgb(246,248,248);AddSummary("这台电脑",computerValue);AddSummary("服务器",serverValue);layout.Controls.Add(summaryPanel);
        pairingPanel=Stack();pairingPanel.Margin=new Padding(0,0,0,20);pairingPanel.Controls.Add(Caption("配对信息"));information.UseSystemPasswordChar=true;information.Dock=DockStyle.Fill;information.BorderStyle=BorderStyle.FixedSingle;information.AccessibleName="网页生成的配对信息";information.Margin=new Padding(0,8,10,8);
        var pasteRow=new TableLayoutPanel {AutoSize=true,Dock=DockStyle.Top,ColumnCount=2,Margin=new Padding(0,4,0,8)};pasteRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));pasteRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,42));pasteRow.Controls.Add(information,0,0);var paste=new Button();StyleButton(paste,"","clipboard-paste",false);paste.Size=new Size(40,38);paste.AccessibleName="粘贴配对信息";tips.SetToolTip(paste,"粘贴配对信息");pasteRow.Controls.Add(paste,1,0);pairingPanel.Controls.Add(pasteRow);
        pairingInput=pasteRow;
        pairingTarget.AutoSize=true;pairingTarget.MaximumSize=new Size(460,0);pairingTarget.ForeColor=Color.FromArgb(105,116,116);pairingTarget.Margin=new Padding(0,0,0,10);pairingPanel.Controls.Add(pairingTarget);
        paste.Click+=async(s,e)=>{if(busy||stopping)return;try{information.Text=Clipboard.GetText().Trim();Working(true);var target=await Run(new {action="validate-pairing",information=information.Text});pairingTarget.Text=Convert.ToString(target["origin"])+"\n"+Convert.ToString(target["name"]);}catch(Exception error){pairingTarget.Text="";SetStatus(error.Message);}finally{Working(false);}};
        StyleButton(legacyButton,"手动填写","chevron-down",false);legacyButton.AutoSize=true;legacyButton.Click+=(s,e)=>{legacyPanel.Visible=!legacyPanel.Visible;information.Enabled=!legacyPanel.Visible;};pairingPanel.Controls.Add(legacyButton);legacyPanel=Stack();legacyPanel.Visible=false;Field("HTTPS 服务器",domain,legacyPanel);Field("设备名称",name,legacyPanel);name.Text=Environment.MachineName;Field("配对码",code,legacyPanel);code.UseSystemPasswordChar=true;pairingPanel.Controls.Add(legacyPanel);layout.Controls.Add(pairingPanel);replace.Visible=false;
        settingsPanel=Stack();settingsPanel.Margin=new Padding(0,0,0,18);settingsPanel.Controls.Add(Caption("设置"));autoStart.Text="Windows 登录后自动连接";autoStart.AutoSize=true;autoStart.Margin=new Padding(0,14,0,14);settingsPanel.Controls.Add(autoStart);settingsFeedback.AutoSize=true;settingsFeedback.MaximumSize=new Size(460,0);settingsFeedback.ForeColor=Color.FromArgb(163,52,52);settingsFeedback.Margin=new Padding(0,0,0,12);settingsFeedback.Visible=false;settingsFeedback.AccessibleName="自动连接设置反馈";settingsPanel.Controls.Add(settingsFeedback);
        var change=new Button();StyleButton(change,"更换服务器","link",false);change.AutoSize=true;change.Click+=(s,e)=>{changingServer=true;settingsVisible=false;information.Clear();pairingTarget.Text="";legacyPanel.Visible=false;information.Enabled=true;UpdateView();};settingsPanel.Controls.Add(change);var folder=new Button();StyleButton(folder,"打开安装目录","external-link",false);folder.AutoSize=true;folder.Click+=(s,e)=>Process.Start(root);settingsPanel.Controls.Add(folder);var remove=new Button();StyleButton(remove,"卸载","",false);remove.AutoSize=true;remove.Click+=(s,e)=>Uninstall();settingsPanel.Controls.Add(remove);var back=new Button();StyleButton(back,"返回","arrow-left",false);back.AutoSize=true;back.Click+=(s,e)=>{settingsVisible=false;UpdateView();};settingsPanel.Controls.Add(back);layout.Controls.Add(settingsPanel);
        var actions=new FlowLayoutPanel {AutoSize=true,Dock=DockStyle.Top,WrapContents=true,Margin=new Padding(0,0,0,18)};StyleButton(primary,installed?"配对并连接":"安装","link",true);StyleButton(cancelPairing,"返回","arrow-left",false);cancelPairing.Click+=(s,e)=>{changingServer=false;information.Clear();code.Clear();UpdateView();};StyleButton(retry,"连接","plug",true);StyleButton(open,"打开 Codex","external-link",false);StyleButton(hub,"打开网页","external-link",false);foreach(var button in new[]{primary,cancelPairing,retry,open,hub}){button.AutoSize=true;button.MinimumSize=new Size(115,40);button.Margin=new Padding(0,0,10,10);actions.Controls.Add(button);}layout.Controls.Add(actions);hub.Click+=(s,e)=>{try{Process.Start(ValidatedHub(domain.Text));}catch(Exception error){SetStatus(error.Message);}};
        connectionPreference.AutoSize=true;connectionPreference.ForeColor=Color.FromArgb(105,116,116);layout.Controls.Add(connectionPreference);details.AutoSize=true;details.MaximumSize=new Size(460,0);details.ForeColor=Color.FromArgb(105,116,116);details.Text=installed?"":"仅为当前 Windows 用户安装 · 无需管理员权限";layout.Controls.Add(details);UpdateView();
    }
    void UpdateView() {
        if(pairingPanel==null)return;
        summaryPanel.Visible=installed&&paired&&!settingsVisible&&!changingServer;
        statePanel.Visible=!settingsVisible;
        pairingPanel.Visible=installed&&statusReadSucceeded&&(!paired||changingServer)&&!settingsVisible;
        pairingInput.Visible=!legacyPanel.Visible;pairingTarget.Visible=!legacyPanel.Visible&&!string.IsNullOrEmpty(pairingTarget.Text);
        settingsPanel.Visible=installed&&settingsVisible;settingsButton.Visible=installed;
        primary.Visible=!installed||pairingPanel.Visible;cancelPairing.Visible=changingServer&&!settingsVisible;
        retry.Visible=installed&&(paired||!statusReadSucceeded)&&!settingsVisible&&!changingServer;
        open.Visible=installed&&!settingsVisible&&!changingServer;hub.Visible=installed&&paired&&!settingsVisible&&!changingServer;
        retry.Text=actionWarning!=null?"重试连接":!statusReadSucceeded?"重试":paused?"连接":"断开连接";retry.Image=Glyph(paused||actionWarning!=null?"plug":"unplug",18);
        stateDescription.Text=installed?(!statusReadSucceeded?"":paused?"已暂停自动连接":paired?"":"尚未配对"):"Codex Mobile Connector";
        connectionPreference.Visible=installed&&paired&&!settingsVisible&&!changingServer;
        connectionPreference.Text=paused?(autoStart.Checked?"登录启动 · 已开启":"登录启动 · 已关闭"):(autoStart.Checked?"Windows 登录后自动连接 · 已开启":"Windows 登录后自动连接 · 已关闭");
    }
    void Working(bool value) { busy=value; bool canConnect=installed && (paired || !statusReadSucceeded); primary.Enabled=!value && !stopping; retry.Enabled=!value && canConnect && !stopping; replace.Enabled=!value && !stopping;pairingPanel.Enabled=!value&&!stopping;settingsButton.Enabled=!value&&!stopping;settingsPanel.Enabled=!value&&!stopping;cancelPairing.Enabled=!value&&!stopping;trayAuto.Enabled=!value&&!stopping; trayConnect.Enabled=!value && canConnect && !stopping; trayDisconnect.Enabled=installed && !stopping;UpdateView(); }
    void SetStatus(string text) { status.Text=text; trayStatus.Text=text; tray.Text=text.Length>63 ? text.Substring(0,63) : text;UpdateView(); }
    string RequestJson(object request) {
        var encoded=new StringBuilder();
        foreach(char c in json.Serialize(request)) {
            if(c>127) encoded.Append("\\u").Append(((int)c).ToString("x4")); else encoded.Append(c);
        }
        return encoded.ToString();
    }
    async Task<Dictionary<string,object>> Run(object request) {
        return await Task.Run(() => {
            var start = new ProcessStartInfo(Path.Combine(root,"runtime","node.exe"), "\"" + Path.Combine(root,"scripts","connector-gui.mjs") + "\"") { WorkingDirectory=root, UseShellExecute=false, CreateNoWindow=true, RedirectStandardInput=true, RedirectStandardOutput=true, RedirectStandardError=true, StandardOutputEncoding=new UTF8Encoding(false), StandardErrorEncoding=new UTF8Encoding(false) };
            start.EnvironmentVariables.Remove("CODEX_APP_TOOLS_PIPE_PATH");
            using (var p = Process.Start(start)) {
                p.StandardInput.Write(RequestJson(request)); p.StandardInput.Close();
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
        if(busy||stopping)return;
        Working(true); SetStatus("正在验证配对信息…");
        int epoch=++actionEpoch;
        try {
            string origin;object request;
            if(legacyPanel.Visible){origin=ValidatedHub(domain.Text);if(code.Text.Length!=43)throw new Exception("请输入网页生成的 43 位配对码。");request=new {action="pair",origin=origin,name=name.Text.Trim(),code=code.Text,replace=paired};}
            else {var target=await Run(new {action="validate-pairing",information=information.Text});origin=Convert.ToString(target.ContainsKey("origin")?target["origin"]:target["server"]);request=new {action="pair",information=information.Text,replace=paired};}
            if(epoch!=actionEpoch){Working(false);return;}
            if(paired&&MessageBox.Show(this,"将这台电脑配对到 "+origin+"？原服务器的设备需要在原网页中撤销。","更换服务器",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)!=DialogResult.OK){await RefreshStatusAfterAction();return;}
            var data=await Run(request);if(epoch==actionEpoch){paired=true;code.Clear();information.Clear();pairingTarget.Text="";replace.Checked=false;changingServer=false;paused=data.ContainsKey("paused")&&(bool)data["paused"];watcherSubmitted=!paused;actionWarning=data.ContainsKey("partialSuccess")&&(bool)data["partialSuccess"]?(data.ContainsKey("warning")?Convert.ToString(data["warning"]):"已配对，自动连接尚未完成。"):null;SetStatus(paused?"已配对，连接已暂停":"等待 Codex");}await RefreshStatusAfterAction();if(actionWarning!=null){details.Text=actionWarning;SetStatus("已配对，启动未完成");}
        }
        catch(Exception e) { if(epoch==actionEpoch)SetStatus(e.Message); Working(false); return; }
        Working(false);
    }
    async Task RefreshStatusAfterAction() {Working(false);await RefreshStatus(false);}
    async Task Connect(string reason="manual") {
        if (busy || stopping) return;
        Working(true); SetStatus("正在连接 Codex…");
        int epoch=++actionEpoch;
        try { var data=await Run(new { action="connect", reason=reason }); if(epoch==actionEpoch){paused=data.ContainsKey("paused") && (bool)data["paused"]; watcherSubmitted=!paused;if(reason=="manual"&&!paused&&data.ContainsKey("recoveryCompleted")&&(bool)data["recoveryCompleted"]){actionWarning=null;details.Text="";} SetStatus(paused ? "连接已暂停" : "等待 Codex 或服务器连接");} }
        catch(Exception e) { if(epoch==actionEpoch)SetStatus("恢复启动失败："+e.Message); }
        Working(false);
    }
    async Task Disconnect(bool quit) {
        if(stopping || exiting) return;
        ++actionEpoch;
        stopping=true; Working(busy); SetStatus("正在断开连接…");
        try {
            var data=await Run(new { action=quit ? "quit" : "disconnect" });
            if(!(bool)data["paused"] || !(bool)data["disconnectVerified"]) throw new Exception("连接状态已被另一操作修改，请重新断开。");
            paused=true; watcherSubmitted=false; SetStatus("连接已断开");
            if(quit){exiting=true;tray.Visible=false;Close();return;}
        } catch(Exception error){SetStatus("未能确认断开："+error.Message);}
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
                computerValue.Text=data.ContainsKey("deviceName")&&!string.IsNullOrWhiteSpace(Convert.ToString(data["deviceName"]))?Convert.ToString(data["deviceName"]):Environment.MachineName;
                serverValue.Text=Convert.ToString(data["origin"]);details.Text=actionWarning??"";
                status.ForeColor=state=="online"||state=="connected"?Color.FromArgb(21,117,81):Color.FromArgb(37,51,51);
                stateIcon.Image=Glyph(state=="online"||state=="connected"?"check":state=="paused"?"unplug":"plug",26);
                if(!stopping) SetStatus(state=="paused" ? "连接已断开" : state=="stopping" ? "断开尚未确认" : state=="online" || state=="connected" ? "已连接" : state=="connecting" ? "正在连接服务器" : "等待 Codex 或服务器连接");
                statusReadSucceeded=true;
                Working(false); return;
            }
            SetStatus("配对这台电脑");
            statusReadSucceeded=true;
        } catch(Exception e) { if(epoch==actionEpoch){statusReadSucceeded=false;status.ForeColor=Color.FromArgb(163,52,52);stateIcon.Image=Glyph("circle-alert",26);SetStatus("连接状态读取失败："+e.Message);} }
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
            key.SetValue("DisplayName","Codex 手机桥接"); key.SetValue("DisplayVersion","0.1.4");
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
        if(args.Length==4 && args[0]=="--install-root" && args[2]=="--qa-status" && !IsDefaultRoot(root)) form.StatusEvidence=Path.GetFullPath(args[3]);
        if(uninstall) form.Shown+=(s,e)=>form.Uninstall();
        if(args.Length==3 && args[0]=="--install-root" && args[2]=="--install") { form.Unattended=true; form.Shown+=async(s,e)=>await form.Install(); }
        if(installed) Task.Run(()=>{while(!form.IsDisposed){int action=WaitHandle.WaitAny(new WaitHandle[]{wake,remove},1000);if(action<2 && form.IsHandleCreated && !form.IsDisposed) try{form.BeginInvoke(action==0 ? new Action(form.Wake) : new Action(form.Uninstall));}catch(InvalidOperationException){}}});
        Application.Run(form);
        if(owner)mutex.ReleaseMutex();
        }
    }
}
