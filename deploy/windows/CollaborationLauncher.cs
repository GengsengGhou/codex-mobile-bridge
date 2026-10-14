using System;
using System.IO;
using System.Reflection;

[assembly: AssemblyTitle("Codex Mobile Bridge Collaboration Launcher")]
[assembly: AssemblyVersion("2.0.1.0")]
static class CollaborationLauncher {
    static int Main(string[] args) {
        try {
            string self=Assembly.GetExecutingAssembly().Location;int code;
            if(DesktopContext.RestartOutside(self,args,true,out code))return code;
            var values=new System.Collections.Generic.List<string>(args);values.Remove("--desktop-context-hop");values.Remove("--desktop-context-final");
            if(values.Count!=2||values[0]!="--install-root"||!Path.IsPathRooted(values[1]))throw new ArgumentException("Invalid connector launch arguments.");
            string root=Path.GetFullPath(values[1]);if(root.StartsWith(@"\\"))throw new ArgumentException("A local connector installation is required.");
            foreach(string path in new[]{Path.Combine(root,"runtime","node.exe"),Path.Combine(root,"scripts","collaboration-mcp.mjs")})for(string current=path;current!=null;current=Path.GetDirectoryName(current))if((File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw new IOException("Connector launch path contains a link.");
            Environment.SetEnvironmentVariable("NODE_OPTIONS",null);Environment.SetEnvironmentVariable("NODE_PATH",null);
            return DesktopContext.Launch(Path.Combine(root,"runtime","node.exe"),new[]{Path.Combine(root,"scripts","collaboration-mcp.mjs")},root,false,true);
        } catch(Exception){Console.Error.WriteLine("Codex Mobile Bridge: cannot open shared collaboration state. Run Repair installation, then restart Codex.");return 1;}
    }
}
