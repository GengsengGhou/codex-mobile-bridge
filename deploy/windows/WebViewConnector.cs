using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
using System.Globalization;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

class ConnectorWindow : Form,IConnectorWindow {
    const string Page="https://connector.invalid/ui/index.html";
    readonly string root;readonly string[] args;readonly JavaScriptSerializer json=new JavaScriptSerializer();
    readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer();
    readonly WebView2 browser=new WebView2();readonly NotifyIcon tray;
    readonly ToolStripMenuItem trayStatus,trayConnect,trayDisconnect,trayAuto;
    Dictionary<string,object> lastStatus;
    bool busy,initializing=true,confirmingPair,uninstallPending,statusReadInFlight,refreshQueued,exiting,ready,uninstallMode;
    Form recoveryWindow;
    readonly object processLock=new object();readonly List<Process> activeReads=new List<Process>();
    int actionEpoch,uninstallRequests;string statusError,actionWarning;
    bool updateInFlight,updateAutomatic=true;DateTime nextUpdateCheck=DateTime.MinValue;string notifiedVersion;
    readonly string lifecycleEvidence,statusEvidence,capturePath;readonly int qaDebugPort;
    public ConnectorWindow(string destination,string[] options) {
        root=destination;args=options;uninstallMode=Array.IndexOf(args,"--uninstall")>=0;
        lifecycleEvidence=QaArgument("--qa-lifecycle");statusEvidence=QaArgument("--qa-status");capturePath=QaArgument("--capture");
        int port;if(int.TryParse(QaArgument("--qa-debug-port"),out port)&&port>=1024&&port<=65535)qaDebugPort=port;
        Text="Codex Mobile Bridge";Icon=ConnectorBootstrap.BrandIcon();ClientSize=new Size(620,700);MinimumSize=new Size(460,580);StartPosition=FormStartPosition.CenterScreen;BackColor=Color.White;AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;
        browser.Dock=DockStyle.Fill;browser.DefaultBackgroundColor=Color.White;Controls.Add(browser);
        var menu=new ContextMenuStrip();trayStatus=new ToolStripMenuItem(DesktopLocale.T("正在检查连接")){Enabled=false};menu.Items.Add(trayStatus);menu.Items.Add(DesktopLocale.T("显示窗口"),null,(s,e)=>Wake());
        trayConnect=new ToolStripMenuItem(DesktopLocale.T("连接"),null,async(s,e)=>await TrayAction("connect"));menu.Items.Add(trayConnect);
        trayDisconnect=new ToolStripMenuItem(DesktopLocale.T("断开连接"),null,async(s,e)=>await TrayAction("disconnect"));menu.Items.Add(trayDisconnect);
        trayAuto=new ToolStripMenuItem(DesktopLocale.T("Windows 登录后自动连接")){CheckOnClick=false};trayAuto.Click+=async(s,e)=>await TrayAction("autostart",new Dictionary<string,object>{{"enabled",!trayAuto.Checked}});menu.Items.Add(trayAuto);
        menu.Items.Add(new ToolStripSeparator());menu.Items.Add(DesktopLocale.T("退出"),null,async(s,e)=>await TrayAction("quit"));
        bool isolatedQa=!ConnectorBootstrap.IsDefaultRoot(root)&&Array.Exists(args,item=>item.StartsWith("--qa-",StringComparison.Ordinal));
        bool showTray=lifecycleEvidence!=null||(!isolatedQa&&capturePath==null);
        tray=new NotifyIcon{Icon=Icon,Text="Codex Mobile Bridge",ContextMenuStrip=menu,Visible=showTray};tray.DoubleClick+=(s,e)=>Wake();
        timer.Interval=3000;timer.Tick+=async(s,e)=>{await RefreshStatus();if(!updateInFlight&&DateTime.UtcNow>=nextUpdateCheck)try{await CheckUpdate(false);}catch{}};
        FormClosing+=(s,e)=>{if(e.CloseReason==CloseReason.WindowsShutDown||e.CloseReason==CloseReason.TaskManagerClosing){exiting=true;timer.Stop();tray.Visible=false;return;}if(!exiting){e.Cancel=true;Hide();}};
        FormClosed+=(s,e)=>{timer.Stop();tray.Dispose();browser.Dispose();if(recoveryWindow!=null&&!recoveryWindow.IsDisposed)recoveryWindow.Close();};
        Shown+=async(s,e)=>await InitializeView();
    }
    string QaArgument(string flag) {if(ConnectorBootstrap.IsDefaultRoot(root))return null;int i=Array.IndexOf(args,flag);return i>=0&&i+1<args.Length?args[i+1]:null;}
    public void Wake(){if(IsDisposed||exiting)return;if(recoveryWindow!=null&&!recoveryWindow.IsDisposed){recoveryWindow.Show();recoveryWindow.WindowState=FormWindowState.Normal;recoveryWindow.Activate();return;}Show();WindowState=FormWindowState.Normal;Activate();}
    public bool RecordUninstallIntent(){if(lifecycleEvidence==null)return false;uninstallRequests++;return true;}
    public Form DialogOwner{get{return recoveryWindow!=null&&!recoveryWindow.IsDisposed?recoveryWindow:this;}}
    public bool BeginUninstall(){if(busy||initializing||confirmingPair||uninstallPending)return false;uninstallPending=true;return true;}
    public void CancelUninstall(){uninstallPending=false;}
    public void ExitForUninstall(){exiting=true;timer.Stop();++actionEpoch;lock(processLock)foreach(var process in activeReads)try{if(!process.HasExited){process.Kill();process.WaitForExit(5000);}}catch(InvalidOperationException){}tray.Visible=false;Close();}
    void OpenExternal(string target){string evidence=QaArgument("--qa-open-evidence");if(evidence!=null)File.AppendAllText(evidence,target+Environment.NewLine);else ConnectorBootstrap.Open(target);}
    bool Flag(string key){return lastStatus!=null&&lastStatus.ContainsKey(key)&&lastStatus[key] is bool&&(bool)lastStatus[key];}
    string Value(string key){return lastStatus!=null&&lastStatus.ContainsKey(key)?Convert.ToString(lastStatus[key]):"";}
    async Task InitializeView() {
        try {
            var options=new CoreWebView2EnvironmentOptions();if(qaDebugPort!=0)options.AdditionalBrowserArguments="--remote-debugging-address=127.0.0.1 --remote-debugging-port="+qaDebugPort;
            string runtime=(!ConnectorBootstrap.IsDefaultRoot(root)&&Array.IndexOf(args,"--qa-no-runtime")>=0)?Path.Combine(root,"qa-runtime-does-not-exist"):null;
            var environment=await CoreWebView2Environment.CreateAsync(runtime,Path.Combine(root,".local","webview2"),options);
            if(IsDisposed||exiting)return;
            await browser.EnsureCoreWebView2Async(environment);
            var core=browser.CoreWebView2;core.Settings.AreHostObjectsAllowed=false;core.Settings.IsWebMessageEnabled=true;core.Settings.AreDefaultContextMenusEnabled=false;core.Settings.AreDevToolsEnabled=qaDebugPort!=0;core.Settings.IsStatusBarEnabled=false;core.Settings.AreBrowserAcceleratorKeysEnabled=false;core.Settings.IsPasswordAutosaveEnabled=false;core.Settings.IsGeneralAutofillEnabled=false;
            core.SetVirtualHostNameToFolderMapping("connector.invalid",Path.Combine(root,"deploy","windows"),CoreWebView2HostResourceAccessKind.DenyCors);
            core.NavigationStarting+=(s,e)=>{if(!string.Equals(e.Uri,Page,StringComparison.Ordinal))e.Cancel=true;};
            core.NewWindowRequested+=(s,e)=>{e.Handled=true;};core.DownloadStarting+=(s,e)=>{e.Cancel=true;};core.PermissionRequested+=(s,e)=>{e.State=CoreWebView2PermissionState.Deny;};
            core.AddWebResourceRequestedFilter("*",CoreWebView2WebResourceContext.All);
            core.WebResourceRequested+=(s,e)=>{Uri uri;bool allowed=Uri.TryCreate(e.Request.Uri,UriKind.Absolute,out uri)&&uri.Scheme=="https"&&uri.Host=="connector.invalid"&&uri.Query==""&&uri.Fragment==""&&(uri.AbsolutePath=="/ui/index.html"||uri.AbsolutePath=="/ui/connector.css"||uri.AbsolutePath=="/ui/connector.js"||uri.AbsolutePath=="/ui/desktop-locale.js"||Regex.IsMatch(uri.AbsolutePath,@"^/icons/[a-z-]+\.svg$"));if(!allowed)e.Response=core.Environment.CreateWebResourceResponse(new MemoryStream(),403,"Forbidden","Content-Type: text/plain");};
            core.WebMessageReceived+=async(s,e)=>await Receive(e);
            core.NavigationCompleted+=async(s,e)=>{if(!e.IsSuccess){statusError=DesktopLocale.T("界面无法载入，请重新安装连接器。");SetTray();return;}if(capturePath!=null){await Task.Delay(350);using(var stream=File.Create(capturePath))await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,stream);}};
            core.Navigate(Page);
        } catch(Exception error) {
            if(IsDisposed||exiting)return;
            initializing=false;
            Controls.Remove(browser);browser.Dispose();timer.Stop();tray.Visible=false;
            var fallback=new DependencyWindow(root,DesktopLocale.T("请安装 Microsoft Edge WebView2 Runtime，然后重新打开连接器。配对数据会保留。"),error is WebView2RuntimeNotFoundException?DesktopLocale.T("未找到 WebView2 Runtime"):error.GetType().Name,this);recoveryWindow=fallback;
            ConnectorBootstrap.DependencyEvidence(fallback,root,args);fallback.FormClosed+=(s,e)=>{exiting=true;Close();};fallback.Show();Hide();
        }
    }
    void Post(object message){if(ready&&!IsDisposed&&browser.CoreWebView2!=null)browser.CoreWebView2.PostWebMessageAsJson(json.Serialize(message));}
    void SetBusy(bool value){busy=value;trayConnect.Enabled=!busy&&Flag("paired");trayAuto.Enabled=!busy;Post(new{type="busy",value=value,reason=initializing?"initialize":"action"});}
    string StateText(){if(statusError!=null)return DesktopLocale.T("连接状态读取失败");if(lastStatus==null)return DesktopLocale.T("正在检查连接");if(!Flag("paired"))return DesktopLocale.T("尚未配对");if(Flag("paused"))return DesktopLocale.T("连接已断开");if(actionWarning!=null)return DesktopLocale.T("已配对，启动未完成");if(Value("state")=="stopping")return DesktopLocale.T("断开尚未确认");if(Flag("hubConnected")&&Flag("bridgeConnected"))return DesktopLocale.T("已连接");return Value("hubState")=="connecting"?DesktopLocale.T("正在连接服务器"):DesktopLocale.T("等待连接");}
    void LocalizeTray(){var menu=tray.ContextMenuStrip;menu.Items[1].Text=DesktopLocale.T("显示窗口");trayConnect.Text=DesktopLocale.T("连接");trayDisconnect.Text=DesktopLocale.T("断开连接");trayAuto.Text=DesktopLocale.T("Windows 登录后自动连接");menu.Items[6].Text=DesktopLocale.T("退出");}
    void SetTray(){string text=StateText();trayStatus.Text=text;string tooltip="Codex Mobile Bridge · "+text;tray.Text=tooltip.Length>63?tooltip.Substring(0,63):tooltip;trayAuto.Checked=Flag("autoStart");trayConnect.Enabled=!busy&&Flag("paired");trayDisconnect.Enabled=Flag("paired");string record=QaArgument("--qa-language-evidence");if(record!=null){var labels=new List<string>();foreach(ToolStripItem item in tray.ContextMenuStrip.Items)if(!(item is ToolStripSeparator))labels.Add(item.Text);File.WriteAllText(record,json.Serialize(new{language=DesktopLocale.Language,title=Text,trayLabels=labels,trayTooltip=tray.Text}));}}
    void PublishStatus(){SetTray();Post(new{type="status",status=lastStatus,error=statusError,warning=actionWarning});}
    async Task RefreshStatus() {
        if(exiting||IsDisposed)return;
        if(busy||confirmingPair||uninstallPending){refreshQueued=true;return;}
        if(statusReadInFlight){refreshQueued=true;return;}
        statusReadInFlight=true;int epoch=actionEpoch;
        try {var data=await Run(new{action="status"});if(epoch!=actionEpoch)return;lastStatus=data;statusError=null;PublishStatus();}
        catch(Exception error){if(epoch==actionEpoch){statusError=DesktopLocale.T("连接状态读取失败：")+error.Message;PublishStatus();}}
        finally {statusReadInFlight=false;if(refreshQueued&&!exiting&&!IsDisposed){refreshQueued=false;BeginInvoke(new Action(async()=>await RefreshStatus()));}}
    }
    void PublishUpdate(Dictionary<string,object> result) {object state;if(!result.TryGetValue("update",out state)||!(state is Dictionary<string,object>))throw new Exception(DesktopLocale.T("后台响应无效。"));Post(new{type="update",update=state});var data=(Dictionary<string,object>)state;object available,version;if(data.TryGetValue("available",out available)&&available is bool&&(bool)available&&data.TryGetValue("latestVersion",out version)&&version is string&&notifiedVersion!=(string)version){notifiedVersion=(string)version;if(!Visible&&tray.Visible)tray.ShowBalloonTip(8000,Text,DesktopLocale.T("发现新版本，可在设置中下载并升级。"),ToolTipIcon.Info);}}
    void ScheduleUpdate(Dictionary<string,object> state,bool enabledNow=false) {
        object raw;updateAutomatic=!state.TryGetValue("automatic",out raw)||!(raw is bool)||(bool)raw;
        string status=state.TryGetValue("status",out raw)?Convert.ToString(raw):"idle";
        DateTime attempt;if(!state.TryGetValue("lastAttemptAt",out raw)||!DateTime.TryParse(Convert.ToString(raw),CultureInfo.InvariantCulture,DateTimeStyles.RoundtripKind,out attempt))attempt=DateTime.UtcNow;
        nextUpdateCheck=!updateAutomatic?DateTime.MaxValue:enabledNow?DateTime.UtcNow:attempt.ToUniversalTime().AddHours(status=="error"?1:24);
        if(updateAutomatic&&status=="idle"&&!state.ContainsKey("lastAttemptAt"))nextUpdateCheck=DateTime.UtcNow;
        RecordUpdateSchedule(status);
    }
    void RecordUpdateSchedule(string status) {string evidence=QaArgument("--qa-update-evidence");if(evidence!=null)File.AppendAllText(evidence,json.Serialize(new{observedAt=DateTime.UtcNow.ToString("o"),nextCheckAt=nextUpdateCheck.ToString("o"),automatic=updateAutomatic,status=status,inFlight=updateInFlight})+Environment.NewLine);}
    async Task<Dictionary<string,object>> CheckUpdate(bool manual) {if(updateInFlight)throw new Exception(DesktopLocale.T("正在检查或下载更新，请稍后重试。"));updateInFlight=true;nextUpdateCheck=DateTime.MaxValue;RecordUpdateSchedule("checking");try{var result=await Run(new{action="check-update",manual=manual});PublishUpdate(result);ScheduleUpdate((Dictionary<string,object>)result["update"]);return result;}catch(Exception error){nextUpdateCheck=updateAutomatic?DateTime.UtcNow.AddHours(1):DateTime.MaxValue;RecordUpdateSchedule("error");Post(new{type="update",error=DesktopLocale.Diagnostic(error.Message)});throw;}finally{updateInFlight=false;}}
    void LaunchVerifiedInstaller(Dictionary<string,object> result) {
        if(busy||initializing||confirmingPair||uninstallPending||exiting)throw new Exception(DesktopLocale.T("正在完成上一操作，请稍后重试。"));
        object verified;if(!result.TryGetValue("installerVerified",out verified)||!(verified is bool)||!(bool)verified)throw new Exception(DesktopLocale.T("后台响应无效。"));
        string version=TextField(result,"installerVersion",40),digest=TextField(result,"installerSha256",64),path=TextField(result,"installerPath",4096);
        object update;var state=result.TryGetValue("update",out update)?update as Dictionary<string,object>:null;object available,latest;if(state==null||!state.TryGetValue("available",out available)||!(available is bool)||!(bool)available||!state.TryGetValue("latestVersion",out latest)||!(latest is string)||(string)latest!=version)throw new Exception(DesktopLocale.T("后台响应无效。"));
        if(!Regex.IsMatch(version,@"^\d+\.\d+\.\d+$")||!Regex.IsMatch(digest,@"^[a-f0-9]{64}$"))throw new Exception(DesktopLocale.T("安装包路径无效。"));
        string directory=Path.GetFullPath(Path.Combine(root,".local","updates")),expected=Path.Combine(directory,"CodexMobileConnector-Setup-v"+version+".exe");
        if(!string.Equals(Path.GetFullPath(path),expected,StringComparison.OrdinalIgnoreCase)||!File.Exists(expected))throw new Exception(DesktopLocale.T("安装包路径无效。"));
        for(var cursor=new DirectoryInfo(directory);cursor!=null;cursor=cursor.Parent)if(cursor.Exists&&(cursor.Attributes&FileAttributes.ReparsePoint)!=0)throw new Exception(DesktopLocale.T("安装包路径无效。"));
        if((File.GetAttributes(expected)&FileAttributes.ReparsePoint)!=0)throw new Exception(DesktopLocale.T("安装包路径无效。"));
        using(var hash=SHA256.Create())using(var file=File.OpenRead(expected)){string actual=BitConverter.ToString(hash.ComputeHash(file)).Replace("-","").ToLowerInvariant();if(actual!=digest)throw new Exception(DesktopLocale.T("安装包校验失败，请重新下载。"));}
        Process.Start(new ProcessStartInfo(expected,"--install-root \""+root+"\" --language "+DesktopLocale.Language){UseShellExecute=true});
    }
    void Fields(Dictionary<string,object> fields,params string[] allowed){foreach(string key in fields.Keys)if(Array.IndexOf(allowed,key)<0)throw new Exception(DesktopLocale.T("请求字段无效。"));}
    string TextField(Dictionary<string,object> data,string key,int maximum){object value;if(!data.TryGetValue(key,out value)||!(value is string)||((string)value).Length>maximum)throw new Exception(DesktopLocale.T("请求内容无效。"));return (string)value;}
    bool BoolField(Dictionary<string,object> data,string key){object value;if(!data.TryGetValue(key,out value)||!(value is bool))throw new Exception(DesktopLocale.T("请求内容无效。"));return (bool)value;}
    async Task Receive(CoreWebView2WebMessageReceivedEventArgs e) {
        int id=0;
        try {
            if(e.Source!=Page||e.WebMessageAsJson.Length>8192)return;
            var request=json.Deserialize<Dictionary<string,object>>(e.WebMessageAsJson);Fields(request,"id","action","payload");
            if(!request.ContainsKey("id")||!(request["id"] is int)||(int)request["id"]<=0)return;id=(int)request["id"];
            string action=TextField(request,"action",40);object raw;if(!request.TryGetValue("payload",out raw)||!(raw is Dictionary<string,object>))throw new Exception(DesktopLocale.T("请求内容无效。"));var payload=(Dictionary<string,object>)raw;
            object result;
            if(action=="ready") {
                Fields(payload);if(ready)throw new Exception(DesktopLocale.T("界面已初始化。"));ready=true;result=new{language=DesktopLocale.Language,deviceName=Environment.MachineName,root=root,version=ConnectorBootstrap.Version,webviewVersion=browser.CoreWebView2.Environment.BrowserVersionString};
                string displayEvidence=QaArgument("--qa-display-evidence");if(displayEvidence!=null)File.WriteAllText(displayEvidence,json.Serialize(new{windowDpi=ConnectorBootstrap.WindowDpi(this),perMonitorV2=ConnectorBootstrap.PerMonitorV2(),clientWidth=ClientSize.Width,clientHeight=ClientSize.Height,browserWidth=browser.ClientSize.Width,browserHeight=browser.ClientSize.Height,trayVisible=tray.Visible,webviewVersion=browser.CoreWebView2.Environment.BrowserVersionString,passwordAutosaveEnabled=browser.CoreWebView2.Settings.IsPasswordAutosaveEnabled,generalAutofillEnabled=browser.CoreWebView2.Settings.IsGeneralAutofillEnabled}));
                SetBusy(true);Post(new{type="result",id=id,ok=true,result=result});BeginInvoke(new Action(async()=>{try{await CheckUpdate(false);}catch{}}));
                if(!uninstallMode){bool initialized=true;try{await Run(new{action="initialize",reason="view"});}catch(Exception error){initialized=false;statusError=error.Message;PublishStatus();}finally{initializing=false;SetBusy(false);}await RefreshStatus();if(Array.IndexOf(args,"--tray")>=0&&initialized&&Flag("paired")){try{await Mutate("connect",new Dictionary<string,object>(),"startup");}catch(Exception error){actionWarning=DesktopLocale.T("登录连接未完成，请明确重试连接：")+error.Message;PublishStatus();}await RefreshStatus();}timer.Start();if(Array.IndexOf(args,"--tray")>=0)Hide();}else{initializing=false;SetBusy(false);}
                if(statusEvidence!=null){File.WriteAllText(statusEvidence,json.Serialize(new{paired=Flag("paired"),paused=Flag("paused"),windowStatus=StateText(),trayStatus=trayStatus.Text,trayTooltip=tray.Text,statusReadSucceeded=statusError==null,connectMenuEnabled=trayConnect.Enabled,retryAvailable=statusError!=null||(Flag("paired")&&!Flag("paused")&&(!Flag("hubConnected")||!Flag("bridgeConnected")))}));exiting=true;Close();}
                if(lifecycleEvidence!=null)await VerifyLifecycle();return;
            }
            if(action=="set-language"){Fields(payload,"language");string selected=TextField(payload,"language",5);DesktopLocale.Save(root,selected);LocalizeTray();SetTray();result=new{language=DesktopLocale.Language};}
            else if(action=="check-update"){Fields(payload,"manual");result=await CheckUpdate(BoolField(payload,"manual"));}
            else if(action=="get-update-state"){Fields(payload);var data=await Run(new{action=action});PublishUpdate(data);ScheduleUpdate((Dictionary<string,object>)data["update"]);result=data;}
            else if(action=="update-preferences"){Fields(payload,"automatic");bool wasEnabled=updateAutomatic;var data=await Run(new{action=action,automatic=BoolField(payload,"automatic")});PublishUpdate(data);ScheduleUpdate((Dictionary<string,object>)data["update"],!wasEnabled);result=data;}
            else if(action=="download-update"){Fields(payload);if(updateInFlight)throw new Exception(DesktopLocale.T("正在检查或下载更新，请稍后重试。"));if(busy||initializing||confirmingPair||uninstallPending)throw new Exception(DesktopLocale.T("正在完成上一操作，请稍后重试。"));updateInFlight=true;try{var data=await Run(new{action=action},300000);PublishUpdate(data);var state=(Dictionary<string,object>)data["update"];ScheduleUpdate(state);object verified,error;if(data.TryGetValue("installerVerified",out verified)&&verified is bool&&(bool)verified)LaunchVerifiedInstaller(data);else if(!state.TryGetValue("error",out error)||!(error is string)||string.IsNullOrWhiteSpace((string)error))throw new Exception(DesktopLocale.T("后台响应无效。"));result=data;}finally{updateInFlight=false;}}
            else if(action=="status"){Fields(payload);await RefreshStatus();result=new{refreshed=true};}
            else if(action=="open-web"){Fields(payload,"origin","setup");string origin=ConnectorBootstrap.ValidatedHub(TextField(payload,"origin",2048));OpenExternal(origin+(BoolField(payload,"setup")?"?setup=connector":""));result=new{opened=true};}
            else if(action=="open-codex"){Fields(payload);try{ConnectorBootstrap.Open("codex://");}catch{throw new Exception(DesktopLocale.T("请从 Windows 开始菜单打开 Codex。"));}result=new{opened=true};}
            else if(action=="open-folder"){Fields(payload);ConnectorBootstrap.Open(root);result=new{opened=true};}
            else if(action=="paste-code"){Fields(payload);string code=Clipboard.GetText().Trim();if(!Regex.IsMatch(code,@"^[A-Za-z0-9_-]{43}$"))throw new Exception(DesktopLocale.T("剪贴板中不是有效的 43 位配对码。"));result=new{code=code};}
            else if(action=="paste-information"){Fields(payload);string information=Clipboard.GetText().Trim();if(information.Length>4096)throw new Exception(DesktopLocale.T("配对信息过长。"));var validated=await Run(new{action="validate-pairing",information=information});var ticket=json.Deserialize<Dictionary<string,object>>(information);result=new{origin=validated["origin"],name=validated["name"],code=ticket["code"]};}
            else if(action=="diagnostics"){Fields(payload);var diagnostics=new{version=ConnectorBootstrap.Version,root=root,webviewVersion=browser.CoreWebView2.Environment.BrowserVersionString,paired=Flag("paired"),origin=Value("origin"),state=Value("state"),hubState=Value("hubState"),bridgeConnected=Flag("bridgeConnected"),paused=Flag("paused"),pauseScope=Value("pauseScope"),autoStart=Flag("autoStart"),statusReadSucceeded=statusError==null};Clipboard.SetText(json.Serialize(diagnostics));result=new{copied=true};}
            else if(action=="uninstall"){Fields(payload);ConnectorBootstrap.RequestUninstall(this,root);result=new{requested=true};}
            else if(action=="pair"||action=="connect"||action=="disconnect"||action=="autostart")result=await Mutate(action,payload,"manual");
            else throw new Exception(DesktopLocale.T("连接程序命令无效。"));
            Post(new{type="result",id=id,ok=true,result=result});
        } catch(Exception error){Post(new{type="result",id=id,ok=false,error=DesktopLocale.Diagnostic(error.Message)});}
    }
    async Task<object> Mutate(string action,Dictionary<string,object> payload,string reason) {
        if(initializing)throw new Exception(DesktopLocale.T("正在准备连接器，请稍后重试。"));
        if(uninstallPending||(busy||confirmingPair)&&action!="disconnect"&&action!="quit")throw new Exception(DesktopLocale.T("正在完成上一操作，请稍后重试。"));
        object request;
        if(action=="pair") {
            Fields(payload,"origin","name","code");string origin=ConnectorBootstrap.ValidatedHub(TextField(payload,"origin",2048)),name=TextField(payload,"name",80).Trim(),code=TextField(payload,"code",43);
            if(name.Length==0||!Regex.IsMatch(code,@"^[A-Za-z0-9_-]{43}$"))throw new Exception(DesktopLocale.T("请输入设备名称和网页生成的 43 位配对码。"));
            if(Flag("paired")){confirmingPair=true;try{if(DesktopDialog.Show(this,DesktopLocale.T("将这台电脑配对到 ")+origin+DesktopLocale.T("？原服务器的设备需要在原网页中撤销。"),DesktopLocale.T("更换服务器"),MessageBoxButtons.OKCancel,MessageBoxIcon.Question)!=DialogResult.OK)return new{cancelled=true};}finally{confirmingPair=false;}}
            request=new{action="pair",origin=origin,name=name,code=code,replace=Flag("paired")};
        } else if(action=="autostart"){Fields(payload,"enabled");request=new{action="autostart",enabled=BoolField(payload,"enabled")};}
        else {Fields(payload);request=action=="connect"?(object)new{action="connect",reason=reason}:new{action=action};}
        int epoch=++actionEpoch;SetBusy(true);
        try {
            var data=await Run(request);
            if(epoch!=actionEpoch){data["superseded"]=true;return data;}
            if(action=="disconnect"||action=="quit") {
                if(!data.ContainsKey("paused")||!(bool)data["paused"]||!data.ContainsKey("disconnectVerified")||!(bool)data["disconnectVerified"])throw new Exception(DesktopLocale.T("未能确认断开，请重试。"));
                if(lastStatus!=null){lastStatus["paused"]=true;lastStatus["state"]="paused";lastStatus["hubState"]="paused";lastStatus["hubConnected"]=false;}statusError=null;PublishStatus();
                if(action=="quit"){exiting=true;tray.Visible=false;Close();return data;}
            }
            if(action=="pair"&&data.ContainsKey("partialSuccess")&&(bool)data["partialSuccess"])actionWarning=DesktopLocale.Diagnostic(Convert.ToString(data["warning"]));
            if(action=="pair"&&data.ContainsKey("paired")&&(bool)data["paired"]){if(lastStatus==null)lastStatus=new Dictionary<string,object>();lastStatus["paired"]=true;lastStatus["origin"]=ConnectorBootstrap.ValidatedHub((string)payload["origin"]);lastStatus["deviceName"]=(string)payload["name"];lastStatus["paused"]=data.ContainsKey("paused")&&(bool)data["paused"];lastStatus["hubConnected"]=false;lastStatus["bridgeConnected"]=false;lastStatus["state"]=Flag("paused")?"paused":"waiting";lastStatus["hubState"]="waiting";statusError=null;PublishStatus();}
            if(action=="connect"&&reason=="manual"&&data.ContainsKey("recoveryCompleted")&&(bool)data["recoveryCompleted"]&&(!data.ContainsKey("paused")||!(bool)data["paused"]))actionWarning=null;
            if(action=="connect"&&lastStatus!=null){lastStatus["paused"]=data.ContainsKey("paused")&&(bool)data["paused"];lastStatus["state"]=Flag("paused")?"paused":"connecting";lastStatus["hubState"]=Flag("paused")?"paused":"connecting";lastStatus["hubConnected"]=false;statusError=null;PublishStatus();}
            return data;
        } finally {if(epoch==actionEpoch){SetBusy(false);if(!exiting&&!IsDisposed)BeginInvoke(new Action(async()=>await RefreshStatus()));}}
    }
    async Task TrayAction(string action,Dictionary<string,object> payload=null){try{await Mutate(action,payload??new Dictionary<string,object>(),"manual");}catch(Exception error){DesktopDialog.Show(this,error.Message,Text,MessageBoxButtons.OK,MessageBoxIcon.Warning);}}
    async Task<Dictionary<string,object>> Run(object request,int timeout=30000) {
        return await Task.Run(()=>{
            var start=new ProcessStartInfo(Path.Combine(root,"runtime","node.exe"),"\""+Path.Combine(root,"scripts","connector-gui.mjs")+"\""){WorkingDirectory=root,UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=new UTF8Encoding(false),StandardErrorEncoding=new UTF8Encoding(false)};
            start.EnvironmentVariables.Remove("CODEX_APP_TOOLS_PIPE_PATH");
            ConnectorBootstrap.ClearRuntimeOverrides(start);
            Process child;lock(processLock){if(exiting)throw new Exception(DesktopLocale.T("连接器正在关闭。"));child=Process.Start(start);activeReads.Add(child);}
            using(var process=child){try{process.StandardInput.Write(ConnectorBootstrap.RequestJson(request));process.StandardInput.Close();var stdout=process.StandardOutput.ReadToEndAsync();var stderr=process.StandardError.ReadToEndAsync();if(!process.WaitForExit(timeout)){process.Kill();throw new Exception(DesktopLocale.T("操作超时，请重试并核对连接状态。"));}Task.WaitAll(stdout,stderr);var result=json.Deserialize<Dictionary<string,object>>(stdout.Result.Trim());if(result==null||!result.ContainsKey("ok")||!(result["ok"] is bool)||!(bool)result["ok"])throw new Exception(result!=null&&result.ContainsKey("error")?DesktopLocale.Diagnostic(Convert.ToString(result["error"])):DesktopLocale.T("后台响应无效。"));return result;}finally{lock(processLock)activeReads.Remove(process);}}
        });
    }
    async Task VerifyLifecycle() {
        var evidence=new Dictionary<string,object>();
        try {await RefreshStatus();Close();evidence["windowCloseHides"]=!Visible&&!IsDisposed;evidence["trayRemainsVisible"]=tray.Visible;Wake();evidence["showWindowPreservesPause"]=Visible&&Flag("paused");Hide();
            using(var second=Process.Start(new ProcessStartInfo(Application.ExecutablePath,"--install-root \""+root+"\""){UseShellExecute=false,CreateNoWindow=true})){await Task.Run(()=>second.WaitForExit(5000));evidence["secondManualInstanceExits"]=second.HasExited;}await Task.Delay(300);evidence["secondManualInstanceShowsOwner"]=Visible&&Flag("paused");Hide();
            using(var second=Process.Start(new ProcessStartInfo(Application.ExecutablePath,"--install-root \""+root+"\" --tray"){UseShellExecute=false,CreateNoWindow=true})){await Task.Run(()=>second.WaitForExit(5000));evidence["secondStartupInstanceExits"]=second.HasExited;}await Task.Delay(300);evidence["secondStartupDoesNotShow"]=!Visible&&Flag("paused");
            using(var second=Process.Start(new ProcessStartInfo(Application.ExecutablePath,"--install-root \""+root+"\" --uninstall"){UseShellExecute=false,CreateNoWindow=true})){await Task.Run(()=>second.WaitForExit(5000));evidence["uninstallSecondInstanceExits"]=second.HasExited;}await Task.Delay(300);evidence["uninstallIntentDelivered"]=uninstallRequests==1;await Mutate("disconnect",new Dictionary<string,object>(),"manual");evidence["disconnectConfirmed"]=Flag("paused");evidence["nativeTrayClicksTested"]=false;File.WriteAllText(lifecycleEvidence,json.Serialize(evidence));await Mutate("quit",new Dictionary<string,object>(),"manual");
        }catch(Exception error){evidence["error"]=error.Message;File.WriteAllText(lifecycleEvidence,json.Serialize(evidence));exiting=true;Close();}
    }
}
