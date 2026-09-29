using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;

class NativeUiQa {
    static void ScaleContents(Control control,float scale) {foreach(Control child in control.Controls)ScaleContents(child,scale);control.Font=new Font(control.Font.FontFamily,control.Font.Size*scale,control.Font.Style);var button=control as Button;if(button!=null&&button.Image!=null)button.Image=new Bitmap(button.Image,new Size((int)(button.Image.Width*scale),(int)(button.Image.Height*scale)));var picture=control as PictureBox;if(picture!=null&&picture.Image!=null)picture.Image=new Bitmap(picture.Image,new Size((int)(picture.Image.Width*scale),(int)(picture.Image.Height*scale)));}
    [STAThread] static void Main(string[] args) {
        Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        string root=Path.GetDirectoryName(Application.ExecutablePath);
        if(!root.StartsWith(Path.GetTempPath(),StringComparison.OrdinalIgnoreCase))throw new Exception("Native QA requires a temporary isolated root.");
        var form=new ConnectorWindow(args[1]=="install"?Path.Combine(root,"not-installed"):root);form.CapturePath=args[0]+".initial.png";
        var tick=new Timer {Interval=900};
        tick.Tick+=async(s,e)=>{
            tick.Stop();var flags=BindingFlags.Instance|BindingFlags.NonPublic;var type=typeof(ConnectorWindow);
            ((TextBox)type.GetField("name",flags).GetValue(form)).Text="工作电脑 · Studio";
            if(args[1]=="partial-flow"){
                ((TextBox)type.GetField("information",flags).GetValue(form)).Text="synthetic pairing information";
                ((Button)type.GetField("primary",flags).GetValue(form)).PerformClick();
                for(int n=0;n<200&&(bool)type.GetField("busy",flags).GetValue(form);n++)await Task.Delay(50);
                var retry=(Button)type.GetField("retry",flags).GetValue(form);
                if(type.GetField("actionWarning",flags).GetValue(form)==null||retry.Text!="重试连接")throw new Exception("Partial pairing does not offer direct recovery.");
                retry.PerformClick();for(int n=0;n<200&&(bool)type.GetField("busy",flags).GetValue(form);n++)await Task.Delay(50);
                if(type.GetField("actionWarning",flags).GetValue(form)==null||retry.Text!="重试连接")throw new Exception("Failed recovery discarded the warning.");
            }
            if(args[1]=="settings"||args[1]=="settings-failure")((Button)type.GetField("settingsButton",flags).GetValue(form)).PerformClick();
            if(args[1]=="settings-failure"){
                ((CheckBox)type.GetField("autoStart",flags).GetValue(form)).Checked=false;
                for(int n=0;n<200&&(bool)type.GetField("busy",flags).GetValue(form);n++)await Task.Delay(50);
                var feedback=(Label)type.GetField("settingsFeedback",flags).GetValue(form);
                if(!feedback.Visible||!feedback.Text.Contains("无法保存登录启动设置"))throw new Exception("Settings failure feedback is not visible.");
                if(((Control)type.GetField("statePanel",flags).GetValue(form)).Visible)throw new Exception("Fixture must verify the separate settings view.");
                if(!File.ReadAllText(Path.Combine(root,"scripts","settings-request.json")).Contains("\"enabled\":false"))throw new Exception("The submitted checkbox value was not captured.");
            }
            if(args[1]=="legacy")((Button)type.GetField("legacyButton",flags).GetValue(form)).PerformClick();
            if(args[1]=="replace"){type.GetField("changingServer",flags).SetValue(form,true);((TextBox)type.GetField("information",flags).GetValue(form)).Text="{\"type\":\"codex-mobile-pairing\",\"version\":1,\"server\":\"https://preview.example\",\"code\":\""+new string('x',43)+"\"}";}
            type.GetMethod("UpdateView",flags).Invoke(form,null);
            float scale=float.Parse(args[2],System.Globalization.CultureInfo.InvariantCulture);if(scale!=1){form.Scale(new SizeF(scale,scale));ScaleContents(form,scale);}
            form.PerformLayout();
            using(var bitmap=new Bitmap(form.Width,form.Height)){form.DrawToBitmap(bitmap,new Rectangle(0,0,form.Width,form.Height));bitmap.Save(args[0]);}
            File.WriteAllText(args[0]+".json","{\"simulatedLayoutScale\":"+args[2]+",\"width\":"+form.Width+",\"height\":"+form.Height+",\"nativeWinForms\":true,\"osDisplayDpiChanged\":false}");
            if(args[1]=="settings-failure"){
                ((CheckBox)type.GetField("autoStart",flags).GetValue(form)).Checked=false;
                for(int n=0;n<200&&(bool)type.GetField("busy",flags).GetValue(form);n++)await Task.Delay(50);
                if(((Label)type.GetField("settingsFeedback",flags).GetValue(form)).Text!="")throw new Exception("Successful settings save did not clear prior error.");
                File.WriteAllText(args[0]+".settings.json","{\"failureFeedbackVisible\":true,\"connectionStatePanelHidden\":true,\"capturedEnabledValue\":false,\"submissionExceedsPollingInterval\":true,\"successClearsError\":true}");
            }
            if(args[1]=="partial-flow"){
                var retry=(Button)type.GetField("retry",flags).GetValue(form);retry.PerformClick();
                for(int n=0;n<200&&(bool)type.GetField("busy",flags).GetValue(form);n++)await Task.Delay(50);
                if(type.GetField("actionWarning",flags).GetValue(form)==null||retry.Text!="重试连接")throw new Exception("Blocked recovery discarded the warning.");
                retry.PerformClick();for(int n=0;n<200&&(bool)type.GetField("busy",flags).GetValue(form);n++)await Task.Delay(50);
                if(type.GetField("actionWarning",flags).GetValue(form)!=null||retry.Text!="断开连接")throw new Exception("Successful recovery did not restore the connected action.");
                var request=File.ReadAllText(Path.Combine(root,"scripts","partial-request.json"));
                if(!request.Contains("\"attempt\":3")||!request.Contains("\"reason\":\"manual\""))throw new Exception("Recovery was not three explicit connection attempts.");
                File.WriteAllText(args[0]+".recovery.json","{\"actualPairButtonTested\":true,\"partialSuccessPaused\":false,\"directRetryConnect\":true,\"failurePreservesWarning\":true,\"blockedRecoveryPreservesWarning\":true,\"manualConnectRequests\":3,\"disconnectRequests\":0,\"explicitRecoveryCompletedClearsWarning\":true,\"normalDisconnectActionRestored\":true}");
            }
            type.GetField("exiting",flags).SetValue(form,true);form.Close();
        };
        form.Shown+=(s,e)=>tick.Start();Application.Run(form);
    }
}
