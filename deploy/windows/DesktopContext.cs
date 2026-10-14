using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// A package can redirect LocalAppData while preserving the apparent path.
// Never start stateful code until the process has proved it is outside that view.
static class DesktopContext {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetCurrentPackageFullName(ref uint length, StringBuilder name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int type);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr duplicate,uint access,bool inherit,uint options);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfoEx startup,out ProcessInformation process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,IntPtr information,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
    [StructLayout(LayoutKind.Sequential)] struct StartupInfo { public int cb;public IntPtr reserved,desktop,title;public uint x,y,width,height,xChars,yChars,fill,flags;public ushort show,reservedSize;public IntPtr reservedBytes,input,output,error; }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo info;public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr process,thread;public uint id,threadId; }
    [StructLayout(LayoutKind.Sequential)] struct JobLimits {public long processTime,jobTime;public uint flags;public UIntPtr minimum,maximum;public uint active;public UIntPtr affinity;public uint priority,scheduling;public ulong readOperations,writeOperations,otherOperations,readBytes,writeBytes,otherBytes;public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;}
    public static bool Packaged { get {uint length=0;int result=GetCurrentPackageFullName(ref length,null);if(result==15700)return false;if(result==122||result==0)return true;throw new Win32Exception(result,"Cannot verify Windows application context.");} }
    public static string Quote(string value) {var result=new StringBuilder("\"");int slashes=0;foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='\"')result.Append('\\',slashes*2+1).Append(c);else result.Append('\\',slashes).Append(c);slashes=0;}return result.Append('\\',slashes*2).Append('"').ToString();}
    public static int Launch(string executable,string[] arguments,string directory,bool desktopTree,bool stdio) {
        IntPtr size=IntPtr.Zero,list=IntPtr.Zero,policy=IntPtr.Zero,handleList=IntPtr.Zero,job=IntPtr.Zero;bool initialized=false;var handles=new System.Collections.Generic.List<IntPtr>();
        ProcessInformation child=new ProcessInformation();
        try {
            int attributes=(desktopTree?1:0)+(stdio?1:0);var startup=new StartupInfoEx();startup.info.cb=Marshal.SizeOf(typeof(StartupInfoEx));
            if(attributes>0){InitializeProcThreadAttributeList(IntPtr.Zero,attributes,0,ref size);list=Marshal.AllocHGlobal(size);if(!InitializeProcThreadAttributeList(list,attributes,0,ref size))throw new Win32Exception();initialized=true;startup.attributes=list;}
            if(desktopTree){policy=Marshal.AllocHGlobal(4);Marshal.WriteInt32(policy,1);if(!UpdateProcThreadAttribute(list,0,new IntPtr(0x20012),policy,new IntPtr(4),IntPtr.Zero,IntPtr.Zero))throw new Win32Exception();}
            if(stdio){foreach(int type in new[]{-10,-11,-12}){IntPtr duplicate;if(!DuplicateHandle(GetCurrentProcess(),GetStdHandle(type),GetCurrentProcess(),out duplicate,0,true,2))throw new Win32Exception();handles.Add(duplicate);}startup.info.flags=0x100;startup.info.input=handles[0];startup.info.output=handles[1];startup.info.error=handles[2];handleList=Marshal.AllocHGlobal(IntPtr.Size*3);for(int i=0;i<3;i++)Marshal.WriteIntPtr(handleList,i*IntPtr.Size,handles[i]);if(!UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handleList,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero))throw new Win32Exception();}
            string command=Quote(executable);foreach(string argument in arguments)command+=" "+Quote(argument);
            if(stdio){job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Win32Exception();var limits=new JobLimits{flags=0x2000};IntPtr information=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JobLimits)));try{Marshal.StructureToPtr(limits,information,false);if(!SetInformationJobObject(job,9,information,(uint)Marshal.SizeOf(typeof(JobLimits))))throw new Win32Exception();}finally{Marshal.FreeHGlobal(information);}}
            if(!CreateProcess(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,stdio,0x80000|0x08000000|(stdio?4u:0u),IntPtr.Zero,directory,ref startup,out child))throw new Win32Exception();
            if(stdio){if(!AssignProcessToJobObject(job,child.process)){TerminateProcess(child.process,1);throw new Win32Exception();}if(ResumeThread(child.thread)==0xffffffff){TerminateProcess(child.process,1);throw new Win32Exception();}}
            foreach(IntPtr handle in handles)CloseHandle(handle);handles.Clear();CloseHandle(child.thread);child.thread=IntPtr.Zero;
            if(WaitForSingleObject(child.process,0xffffffff)!=0)throw new Win32Exception();uint exit;if(!GetExitCodeProcess(child.process,out exit))throw new Win32Exception();return unchecked((int)exit);
        } finally {foreach(IntPtr handle in handles)CloseHandle(handle);if(child.thread!=IntPtr.Zero)CloseHandle(child.thread);if(child.process!=IntPtr.Zero)CloseHandle(child.process);if(job!=IntPtr.Zero)CloseHandle(job);if(list!=IntPtr.Zero){if(initialized)DeleteProcThreadAttributeList(list);Marshal.FreeHGlobal(list);}if(policy!=IntPtr.Zero)Marshal.FreeHGlobal(policy);if(handleList!=IntPtr.Zero)Marshal.FreeHGlobal(handleList);}
    }
    // ENABLE_PROCESS_TREE applies to descendants. Two bounded hops ensure the
    // final process verifies its own identity rather than assuming API success.
    public static bool RestartOutside(string executable,string[] args,bool stdio,out int code) {
        code=0;if(!Packaged)return false;
        var arguments=new System.Collections.Generic.List<string>(args);int hop=arguments.IndexOf("--desktop-context-hop"),final=arguments.IndexOf("--desktop-context-final");
        if(final>=0)throw new InvalidOperationException("Windows could not open the shared connector state. Run Repair installation, then restart Codex.");
        if(hop>=0)arguments[hop]="--desktop-context-final";else arguments.Insert(0,"--desktop-context-hop");
        code=Launch(executable,arguments.ToArray(),null,true,stdio);return true;
    }
}
