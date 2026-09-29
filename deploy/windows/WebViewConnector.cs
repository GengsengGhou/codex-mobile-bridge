using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
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
    readonly string lifecycleEvidence,statusEvidence,capturePath;readonly int qaDebugPort;
    public ConnectorWindow(string destination,string[] options) {
        root=destination;args=options;uninstallMode=Array.IndexOf(args,"--uninstall")>=0;
        lifecycleEvidence=QaArgument("--qa-lifecycle");statusEvidence=QaArgument("--qa-status");capturePath=QaArgument("--capture");
        int port;if(int.TryParse(QaArgument("--qa-debug-port"),out port)&&port>=1024&&port<=65535)qaDebugPort=port;
        Text="Codex 手机桥接";Icon=ConnectorBootstrap.BrandIcon();ClientSize=new Size(620,700);MinimumSize=new Size(460,580);StartPosition=FormStartPosition.CenterScreen;BackColor=Color.White;AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;
        browser.Dock=DockStyle.Fill;browser.DefaultBackgroundColor=Color.White;Controls.Add(browser);
        var menu=new ContextMenuStrip();trayStatus=new ToolStripMenuItem("正在检查连接"){Enabled=false};menu.Items.Add(trayStatus);menu.Items.Add("显示窗口",null,(s,e)=>Wake());
        trayConnect=new ToolStripMenuItem("连接",null,async(s,e)=>await TrayAction("connect"));menu.Items.Add(trayConnect);
        trayDisconnect=new ToolStripMenuItem("断开连接",null,async(s,e)=>await TrayAction("disconnect"));menu.Items.Add(trayDisconnect);
        trayAuto=new ToolStripMenuItem("Windows 登录后自动连接"){CheckOnClick=false};trayAuto.Click+=async(s,e)=>await TrayAction("autostart",new Dictionary<string,object>{{"enabled",!trayAuto.Checked}});menu.Items.Add(trayAuto);
        menu.Items.Add(new ToolStripSeparator());menu.Items.Add("退出",null,async(s,e)=>await TrayAction("quit"));
        bool isolatedQa=!ConnectorBootstrap.IsDefaultRoot(root)&&Array.Exists(args,item=>item.StartsWith("--qa-",StringComparison.Ordinal));
        bool showTray=lifecycleEvidence!=null||(!isolatedQa&&capturePath==null);
        tray=new NotifyIcon{Icon=Icon,Text="Codex 手机桥接",ContextMenuStrip=menu,Visible=showTray};tray.DoubleClick+=(s,e)=>Wake();
        timer.Interval=3000;timer.Tick+=async(s,e)=>await RefreshStatus();
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
            core.WebResourceRequested+=(s,e)=>{Uri uri;bool allowed=Uri.TryCreate(e.Request.Uri,UriKind.Absolute,out uri)&&uri.Scheme=="https"&&uri.Host=="connector.invalid"&&uri.Query==""&&uri.Fragment==""&&(uri.AbsolutePath=="/ui/index.html"||uri.AbsolutePath=="/ui/connector.css"||uri.AbsolutePath=="/ui/connector.js"||Regex.IsMatch(uri.AbsolutePath,@"^/icons/[a-z-]+\.svg$"));if(!allowed)e.Response=core.Environment.CreateWebResourceResponse(new MemoryStream(),403,"Forbidden","Content-Type: text/plain");};
            core.WebMessageReceived+=async(s,e)=>await Receive(e);
            core.NavigationCompleted+=async(s,e)=>{if(!e.IsSuccess){statusError="界面无法载入，请重新安装连接器。";SetTray();return;}if(capturePath!=null){await Task.Delay(350);using(var stream=File.Create(capturePath))await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,stream);}};
            core.Navigate(Page);
        } catch(Exception error) {
            if(IsDisposed||exiting)return;
            initializing=false;
            Controls.Remove(browser);browser.Dispose();timer.Stop();tray.Visible=false;
            var fallback=new DependencyWindow(root,"请安装 Microsoft Edge WebView2 Runtime，然后重新打开连接器。配对数据会保留。",error is WebView2RuntimeNotFoundException?"未找到 WebView2 Runtime":error.GetType().Name,this);recoveryWindow=fallback;
            ConnectorBootstrap.DependencyEvidence(fallback,root,args);fallback.FormClosed+=(s,e)=>{exiting=true;Close();};fallback.Show();Hide();
        }
    }
    void Post(object message){if(ready&&!IsDisposed&&browser.CoreWebView2!=null)browser.CoreWebView2.PostWebMessageAsJson(json.Serialize(message));}
    void SetBusy(bool value){busy=value;trayConnect.Enabled=!busy&&Flag("paired");trayAuto.Enabled=!busy;Post(new{type="busy",value=value,reason=initializing?"initialize":"action"});}
    string StateText(){if(statusError!=null)return "连接状态读取失败";if(lastStatus==null)return "正在检查连接";if(!Flag("paired"))return "尚未配对";if(Flag("paused"))return "连接已断开";if(actionWarning!=null)return "已配对，启动未完成";if(Value("state")=="stopping")return "断开尚未确认";if(Flag("hubConnected")&&Flag("bridgeConnected"))return "已连接";return Value("hubState")=="connecting"?"正在连接服务器":"等待连接";}
    void SetTray(){string text=StateText();trayStatus.Text=text;tray.Text=text.Length>63?text.Substring(0,63):text;trayAuto.Checked=Flag("autoStart");trayConnect.Enabled=!busy&&Flag("paired");trayDisconnect.Enabled=Flag("paired");}
    void PublishStatus(){SetTray();Post(new{type="status",status=lastStatus,error=statusError,warning=actionWarning});}
    async Task RefreshStatus() {
        if(exiting||IsDisposed)return;
        if(busy||confirmingPair||uninstallPending){refreshQueued=true;return;}
        if(statusReadInFlight){refreshQueued=true;return;}
        statusReadInFlight=true;int epoch=actionEpoch;
        try {var data=await Run(new{action="status"});if(epoch!=actionEpoch)return;lastStatus=data;statusError=null;PublishStatus();}
        catch(Exception error){if(epoch==actionEpoch){statusError="连接状态读取失败："+error.Message;PublishStatus();}}
        finally {statusReadInFlight=false;if(refreshQueued&&!exiting&&!IsDisposed){refreshQueued=false;BeginInvoke(new Action(async()=>await RefreshStatus()));}}
    }
    void Fields(Dictionary<string,object> fields,params string[] allowed){foreach(string key in fields.Keys)if(Array.IndexOf(allowed,key)<0)throw new Exception("请求字段无效。");}
    string TextField(Dictionary<string,object> data,string key,int maximum){object value;if(!data.TryGetValue(key,out value)||!(value is string)||((string)value).Length>maximum)throw new Exception("请求内容无效。");return (string)value;}
    bool BoolField(Dictionary<string,object> data,string key){object value;if(!data.TryGetValue(key,out value)||!(value is bool))throw new Exception("请求内容无效。");return (bool)value;}
    async Task Receive(CoreWebView2WebMessageReceivedEventArgs e) {
        int id=0;
        try {
            if(e.Source!=Page||e.WebMessageAsJson.Length>8192)return;
            var request=json.Deserialize<Dictionary<string,object>>(e.WebMessageAsJson);Fields(request,"id","action","payload");
            if(!request.ContainsKey("id")||!(request["id"] is int)||(int)request["id"]<=0)return;id=(int)request["id"];
            string action=TextField(request,"action",40);object raw;if(!request.TryGetValue("payload",out raw)||!(raw is Dictionary<string,object>))throw new Exception("请求内容无效。");var payload=(Dictionary<string,object>)raw;
            object result;
            if(action=="ready") {
                Fields(payload);if(ready)throw new Exception("界面已初始化。");ready=true;result=new{deviceName=Environment.MachineName,root=root,version=ConnectorBootstrap.Version,webviewVersion=browser.CoreWebView2.Environment.BrowserVersionString};
                string displayEvidence=QaArgument("--qa-display-evidence");if(displayEvidence!=null)File.WriteAllText(displayEvidence,json.Serialize(new{windowDpi=ConnectorBootstrap.WindowDpi(this),perMonitorV2=ConnectorBootstrap.PerMonitorV2(),clientWidth=ClientSize.Width,clientHeight=ClientSize.Height,browserWidth=browser.ClientSize.Width,browserHeight=browser.ClientSize.Height,trayVisible=tray.Visible,webviewVersion=browser.CoreWebView2.Environment.BrowserVersionString,passwordAutosaveEnabled=browser.CoreWebView2.Settings.IsPasswordAutosaveEnabled,generalAutofillEnabled=browser.CoreWebView2.Settings.IsGeneralAutofillEnabled}));
                SetBusy(true);Post(new{type="result",id=id,ok=true,result=result});
                if(!uninstallMode){bool initialized=true;try{await Run(new{action="initialize",reason="view"});}catch(Exception error){initialized=false;statusError=error.Message;PublishStatus();}finally{initializing=false;SetBusy(false);}await RefreshStatus();if(Array.IndexOf(args,"--tray")>=0&&initialized&&Flag("paired")){try{await Mutate("connect",new Dictionary<string,object>(),"startup");}catch(Exception error){actionWarning="登录连接未完成，请明确重试连接："+error.Message;PublishStatus();}await RefreshStatus();}timer.Start();if(Array.IndexOf(args,"--tray")>=0)Hide();}else{initializing=false;SetBusy(false);}
                if(statusEvidence!=null){File.WriteAllText(statusEvidence,json.Serialize(new{paired=Flag("paired"),paused=Flag("paused"),windowStatus=StateText(),trayStatus=trayStatus.Text,trayTooltip=tray.Text,statusReadSucceeded=statusError==null,connectMenuEnabled=trayConnect.Enabled,retryAvailable=statusError!=null||(Flag("paired")&&!Flag("paused")&&(!Flag("hubConnected")||!Flag("bridgeConnected")))}));exiting=true;Close();}
                if(lifecycleEvidence!=null)await VerifyLifecycle();return;
            }
            if(action=="status"){Fields(payload);await RefreshStatus();result=new{refreshed=true};}
            else if(action=="open-web"){Fields(payload,"origin","setup");string origin=ConnectorBootstrap.ValidatedHub(TextField(payload,"origin",2048));OpenExternal(origin+(BoolField(payload,"setup")?"?setup=connector":""));result=new{opened=true};}
            else if(action=="open-codex"){Fields(payload);try{ConnectorBootstrap.Open("codex://");}catch{throw new Exception("请从 Windows 开始菜单打开 Codex。");}result=new{opened=true};}
            else if(action=="open-folder"){Fields(payload);ConnectorBootstrap.Open(root);result=new{opened=true};}
            else if(action=="paste-code"){Fields(payload);string code=Clipboard.GetText().Trim();if(!Regex.IsMatch(code,@"^[A-Za-z0-9_-]{43}$"))throw new Exception("剪贴板中不是有效的 43 位配对码。");result=new{code=code};}
            else if(action=="paste-information"){Fields(payload);string information=Clipboard.GetText().Trim();if(information.Length>4096)throw new Exception("配对信息过长。");var validated=await Run(new{action="validate-pairing",information=information});var ticket=json.Deserialize<Dictionary<string,object>>(information);result=new{origin=validated["origin"],name=validated["name"],code=ticket["code"]};}
            else if(action=="diagnostics"){Fields(payload);var diagnostics=new{version=ConnectorBootstrap.Version,root=root,webviewVersion=browser.CoreWebView2.Environment.BrowserVersionString,paired=Flag("paired"),origin=Value("origin"),state=Value("state"),hubState=Value("hubState"),bridgeConnected=Flag("bridgeConnected"),paused=Flag("paused"),pauseScope=Value("pauseScope"),autoStart=Flag("autoStart"),statusReadSucceeded=statusError==null};Clipboard.SetText(json.Serialize(diagnostics));result=new{copied=true};}
            else if(action=="uninstall"){Fields(payload);ConnectorBootstrap.RequestUninstall(this,root);result=new{requested=true};}
            else if(action=="pair"||action=="connect"||action=="disconnect"||action=="autostart")result=await Mutate(action,payload,"manual");
            else throw new Exception("连接程序命令无效。");
            Post(new{type="result",id=id,ok=true,result=result});
        } catch(Exception error){Post(new{type="result",id=id,ok=false,error=error.Message});}
    }
    async Task<object> Mutate(string action,Dictionary<string,object> payload,string reason) {
        if(initializing)throw new Exception("正在准备连接器，请稍后重试。");
        if(uninstallPending||(busy||confirmingPair)&&action!="disconnect"&&action!="quit")throw new Exception("正在完成上一操作，请稍后重试。");
        object request;
        if(action=="pair") {
            Fields(payload,"origin","name","code");string origin=ConnectorBootstrap.ValidatedHub(TextField(payload,"origin",2048)),name=TextField(payload,"name",80).Trim(),code=TextField(payload,"code",43);
            if(name.Length==0||!Regex.IsMatch(code,@"^[A-Za-z0-9_-]{43}$"))throw new Exception("请输入设备名称和网页生成的 43 位配对码。");
            if(Flag("paired")){confirmingPair=true;try{if(MessageBox.Show(this,"将这台电脑配对到 "+origin+"？原服务器的设备需要在原网页中撤销。","更换服务器",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)!=DialogResult.OK)return new{cancelled=true};}finally{confirmingPair=false;}}
            request=new{action="pair",origin=origin,name=name,code=code,replace=Flag("paired")};
        } else if(action=="autostart"){Fields(payload,"enabled");request=new{action="autostart",enabled=BoolField(payload,"enabled")};}
        else {Fields(payload);request=action=="connect"?(object)new{action="connect",reason=reason}:new{action=action};}
        int epoch=++actionEpoch;SetBusy(true);
        try {
            var data=await Run(request);
            if(epoch!=actionEpoch){data["superseded"]=true;return data;}
            if(action=="disconnect"||action=="quit") {
                if(!data.ContainsKey("paused")||!(bool)data["paused"]||!data.ContainsKey("disconnectVerified")||!(bool)data["disconnectVerified"])throw new Exception("未能确认断开，请重试。");
                if(lastStatus!=null){lastStatus["paused"]=true;lastStatus["state"]="paused";lastStatus["hubState"]="paused";lastStatus["hubConnected"]=false;}statusError=null;PublishStatus();
                if(action=="quit"){exiting=true;tray.Visible=false;Close();return data;}
            }
            if(action=="pair"&&data.ContainsKey("partialSuccess")&&(bool)data["partialSuccess"])actionWarning=Convert.ToString(data["warning"]);
            if(action=="pair"&&data.ContainsKey("paired")&&(bool)data["paired"]){if(lastStatus==null)lastStatus=new Dictionary<string,object>();lastStatus["paired"]=true;lastStatus["origin"]=ConnectorBootstrap.ValidatedHub((string)payload["origin"]);lastStatus["deviceName"]=(string)payload["name"];lastStatus["paused"]=data.ContainsKey("paused")&&(bool)data["paused"];lastStatus["hubConnected"]=false;lastStatus["bridgeConnected"]=false;lastStatus["state"]=Flag("paused")?"paused":"waiting";lastStatus["hubState"]="waiting";statusError=null;PublishStatus();}
            if(action=="connect"&&reason=="manual"&&data.ContainsKey("recoveryCompleted")&&(bool)data["recoveryCompleted"]&&(!data.ContainsKey("paused")||!(bool)data["paused"]))actionWarning=null;
            if(action=="connect"&&lastStatus!=null){lastStatus["paused"]=data.ContainsKey("paused")&&(bool)data["paused"];lastStatus["state"]=Flag("paused")?"paused":"connecting";lastStatus["hubState"]=Flag("paused")?"paused":"connecting";lastStatus["hubConnected"]=false;statusError=null;PublishStatus();}
            return data;
        } finally {if(epoch==actionEpoch){SetBusy(false);if(!exiting&&!IsDisposed)BeginInvoke(new Action(async()=>await RefreshStatus()));}}
    }
    async Task TrayAction(string action,Dictionary<string,object> payload=null){try{await Mutate(action,payload??new Dictionary<string,object>(),"manual");}catch(Exception error){MessageBox.Show(this,error.Message,Text,MessageBoxButtons.OK,MessageBoxIcon.Warning);}}
    async Task<Dictionary<string,object>> Run(object request) {
        return await Task.Run(()=>{
            var start=new ProcessStartInfo(Path.Combine(root,"runtime","node.exe"),"\""+Path.Combine(root,"scripts","connector-gui.mjs")+"\""){WorkingDirectory=root,UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=new UTF8Encoding(false),StandardErrorEncoding=new UTF8Encoding(false)};
            start.EnvironmentVariables.Remove("CODEX_APP_TOOLS_PIPE_PATH");
            Process child;lock(processLock){if(exiting)throw new Exception("连接器正在关闭。");child=Process.Start(start);activeReads.Add(child);}
            using(var process=child){try{process.StandardInput.Write(ConnectorBootstrap.RequestJson(request));process.StandardInput.Close();var stdout=process.StandardOutput.ReadToEndAsync();var stderr=process.StandardError.ReadToEndAsync();if(!process.WaitForExit(30000)){process.Kill();throw new Exception("操作超时，请重试并核对连接状态。");}Task.WaitAll(stdout,stderr);var result=json.Deserialize<Dictionary<string,object>>(stdout.Result.Trim());if(result==null||!result.ContainsKey("ok")||!(result["ok"] is bool)||!(bool)result["ok"])throw new Exception(result!=null&&result.ContainsKey("error")?Convert.ToString(result["error"]):"后台响应无效。");return result;}finally{lock(processLock)activeReads.Remove(process);}}
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
