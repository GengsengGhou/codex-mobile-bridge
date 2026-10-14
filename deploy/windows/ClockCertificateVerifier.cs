using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// One-shot, offline trust verification. The caller checks the hostname on the
// very same TLS socket before allowing application data to leave that socket.
internal static class ClockCertificateVerifier
{
    const uint OfflineFlags = 0x4 | 0x100 | 0x2000;
    const int InputLimit = 2 * 1024 * 1024;
    static int completed;
    sealed class Reject : Exception { public string Code; public Reject(string code) { Code = code; } }
    [StructLayout(LayoutKind.Sequential)] struct Trust { public uint Error, Info; }
    [StructLayout(LayoutKind.Sequential)] struct Context { public uint Encoding; public IntPtr Encoded; public uint Length; public IntPtr Info, Store; }
    [StructLayout(LayoutKind.Sequential)] struct EngineConfig { public uint Size; public IntPtr RestrictedRoot, RestrictedTrust, RestrictedOther; public uint AdditionalCount; public IntPtr Additional; public uint Flags, Timeout, Maximum, Cycle; public IntPtr ExclusiveRoot, ExclusivePeople; public uint ExclusiveFlags; }
    [StructLayout(LayoutKind.Sequential)] struct Usage { public uint Count; public IntPtr Oids; }
    [StructLayout(LayoutKind.Sequential)] struct UsageMatch { public uint Type; public Usage Usage; }
    [StructLayout(LayoutKind.Sequential)] struct ChainPara { public uint Size; public UsageMatch Requested, Issuance; public uint Timeout; public int Freshness; public uint FreshnessTime; public IntPtr Resync, Strong; public uint StrongFlags; }
    [StructLayout(LayoutKind.Sequential)] struct Strong { public uint Size, Choice; public IntPtr Oid; }
    [StructLayout(LayoutKind.Sequential)] struct Chain { public uint Size; public Trust Trust; public uint Count; public IntPtr Chains; }
    [StructLayout(LayoutKind.Sequential)] struct Simple { public uint Size; public Trust Trust; public uint Count; public IntPtr Elements; }
    [StructLayout(LayoutKind.Sequential)] struct Element { public uint Size; public IntPtr Certificate; public Trust Trust; }
    [StructLayout(LayoutKind.Sequential)] struct PolicyPara { public uint Size, Flags; public IntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct PolicyStatus { public uint Size, Error; public int Chain, Element; public IntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct SslPara { public uint Size, Auth, Checks; public IntPtr Name; }
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
    [DllImport("crypt32.dll", SetLastError=true)] static extern IntPtr CertOpenStore(IntPtr provider, uint encoding, IntPtr crypt, uint flags, IntPtr para);
    [DllImport("crypt32.dll")] static extern bool CertCloseStore(IntPtr store, uint flags);
    [DllImport("crypt32.dll", SetLastError=true)] static extern IntPtr CertCreateCertificateContext(uint encoding, byte[] bytes, uint length);
    [DllImport("crypt32.dll")] static extern bool CertFreeCertificateContext(IntPtr context);
    [DllImport("crypt32.dll", SetLastError=true)] static extern bool CertAddCertificateContextToStore(IntPtr store, IntPtr context, uint disposition, IntPtr output);
    [DllImport("crypt32.dll", SetLastError=true)] static extern bool CertCreateCertificateChainEngine(ref EngineConfig config, out IntPtr engine);
    [DllImport("crypt32.dll")] static extern void CertFreeCertificateChainEngine(IntPtr engine);
    [DllImport("crypt32.dll", SetLastError=true)] static extern bool CertGetCertificateChain(IntPtr engine, IntPtr cert, ref FileTime time, IntPtr extra, ref ChainPara para, uint flags, IntPtr reserved, out IntPtr chain);
    [DllImport("crypt32.dll")] static extern void CertFreeCertificateChain(IntPtr chain);
    [DllImport("crypt32.dll", SetLastError=true)] static extern bool CertVerifyCertificateChainPolicy(IntPtr policy, IntPtr chain, ref PolicyPara para, ref PolicyStatus status);
    static T Read<T>(IntPtr ptr) { return (T)Marshal.PtrToStructure(ptr, typeof(T)); }
    static uint Size<T>() { return (uint)Marshal.SizeOf(typeof(T)); }
    static byte[] Bytes(IntPtr certificate) { Context c = Read<Context>(certificate); if (c.Length > 131072) throw new Reject("INVALID_CERTIFICATE"); byte[] bytes = new byte[c.Length]; Marshal.Copy(c.Encoded, bytes, 0, bytes.Length); return bytes; }
    static string Key(byte[] bytes) { return Convert.ToBase64String(bytes); }
    static void Emit(bool ok, string code) { if (Interlocked.Exchange(ref completed, 1) == 0) { Console.Out.WriteLine("{\"ok\":" + (ok ? "true" : "false") + ",\"code\":\"" + code + "\"}"); Console.Out.Flush(); } }
    static int Main()
    {
        using (Timer timer = new Timer(delegate { Emit(false, "TIMEOUT"); Environment.Exit(2); }, null, 9000, Timeout.Infinite)) {
            try { Verify(); Emit(true, "OK"); return 0; }
            catch (Reject e) { Emit(false, e.Code); return 1; }
            catch { Emit(false, "VERIFIER_ERROR"); return 2; }
        }
    }
    static IList List(Dictionary<string, object> input, string name, int cap)
    {
        object value; if (!input.TryGetValue(name, out value)) throw new Reject("INVALID_INPUT");
        IList result = value as IList; if (result == null || result.Count < 1 || result.Count > cap) throw new Reject("INVALID_INPUT"); return result;
    }
    static void Verify()
    {
        // Read bytes, not an unbounded ReadToEnd; UTF-8 is the protocol encoding.
        var stream = Console.OpenStandardInput(); var data = new List<byte>(); byte[] buffer = new byte[8192]; int n;
        while ((n = stream.Read(buffer, 0, buffer.Length)) > 0) { if (data.Count + n > InputLimit) throw new Reject("INPUT_TOO_LARGE"); for (int i=0;i<n;i++) data.Add(buffer[i]); }
        Dictionary<string, object> input;
        try { var json = new JavaScriptSerializer { MaxJsonLength = InputLimit, RecursionLimit = 8 }; input = json.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false,true).GetString(data.ToArray())); }
        catch { throw new Reject("INVALID_INPUT"); }
        object version, reference;
        if (input == null || input.Count != 4 || !input.TryGetValue("version", out version) || !(version is int) || (int)version != 1 || !input.TryGetValue("referenceTime", out reference) || !(reference is string)) throw new Reject("INVALID_INPUT");
        string date = (string)reference; DateTimeOffset instant;
        if (date.Length > 40 || !System.Text.RegularExpressions.Regex.IsMatch(date, @"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$") || !DateTimeOffset.TryParse(date, CultureInfo.InvariantCulture, DateTimeStyles.None, out instant) || instant.UtcDateTime.Year < 2000 || instant.UtcDateTime.Year > 2100) throw new Reject("INVALID_REFERENCE_TIME");
        IList roots = List(input, "trustRoots", 512), peers = List(input, "peerChain", 32);
        var contexts = new List<IntPtr>(); var allocations = new List<IntPtr>(); var supplied = new HashSet<string>(); var rootKeys = new HashSet<string>();
        IntPtr rootStore=IntPtr.Zero, peerStore=IntPtr.Zero, engine=IntPtr.Zero, chain=IntPtr.Zero;
        try {
            rootStore = CertOpenStore(new IntPtr(2), 0, IntPtr.Zero, 0, IntPtr.Zero); peerStore = CertOpenStore(new IntPtr(2), 0, IntPtr.Zero, 0, IntPtr.Zero);
            if (rootStore == IntPtr.Zero || peerStore == IntPtr.Zero) throw new Reject("VERIFIER_ERROR");
            IntPtr leaf=IntPtr.Zero;
            for (int group=0;group<2;group++) { IList certs=group==0?roots:peers; for (int i=0;i<certs.Count;i++) {
                string encoded=certs[i] as string; byte[] der;
                if (encoded == null || encoded.Length > 174764) throw new Reject("INVALID_CERTIFICATE");
                try { der=Convert.FromBase64String(encoded); } catch { throw new Reject("INVALID_CERTIFICATE"); }
                if (der.Length == 0 || der.Length > 131072 || Key(der) != encoded) throw new Reject("INVALID_CERTIFICATE");
                IntPtr ctx=CertCreateCertificateContext(1,der,(uint)der.Length); if (ctx==IntPtr.Zero) throw new Reject("INVALID_CERTIFICATE"); contexts.Add(ctx);
                if (Key(Bytes(ctx))!=encoded) throw new Reject("INVALID_CERTIFICATE"); supplied.Add(encoded); if(group==0) rootKeys.Add(encoded); else if(i==0) leaf=ctx;
                if (!CertAddCertificateContextToStore(group==0?rootStore:peerStore,ctx,4,IntPtr.Zero)) throw new Reject("INVALID_CERTIFICATE");
            } }
            var config=new EngineConfig { Size=Size<EngineConfig>(), ExclusiveRoot=rootStore, Flags=OfflineFlags, Timeout=1, Maximum=1024 };
            if (!CertCreateCertificateChainEngine(ref config,out engine)) throw new Reject("VERIFIER_ERROR");
            IntPtr oid=Marshal.StringToHGlobalAnsi("1.3.6.1.5.5.7.3.1"); allocations.Add(oid); IntPtr oids=Marshal.AllocHGlobal(IntPtr.Size); allocations.Add(oids); Marshal.WriteIntPtr(oids,oid);
            IntPtr strongOid=Marshal.StringToHGlobalAnsi("1.3.6.1.4.1.311.72.1.1"); allocations.Add(strongOid); IntPtr strongPtr=Marshal.AllocHGlobal((int)Size<Strong>()); allocations.Add(strongPtr); Marshal.StructureToPtr(new Strong {Size=Size<Strong>(),Choice=2,Oid=strongOid},strongPtr,false);
            var para=new ChainPara {Size=Size<ChainPara>(),Requested=new UsageMatch {Usage=new Usage {Count=1,Oids=oids}},Timeout=1,Strong=strongPtr};
            long ft=instant.UtcDateTime.ToFileTimeUtc(); var time=new FileTime {Low=(uint)ft,High=(uint)(ft>>32)};
            if (!CertGetCertificateChain(engine,leaf,ref time,peerStore,ref para,OfflineFlags,IntPtr.Zero,out chain)) throw new Reject("CHAIN_REJECTED");
            Chain result=Read<Chain>(chain); if(result.Trust.Error!=0 || result.Count!=1) throw new Reject("CHAIN_REJECTED");
            Simple simple=Read<Simple>(Marshal.ReadIntPtr(result.Chains)); if(simple.Trust.Error!=0 || simple.Count<1 || simple.Count>33) throw new Reject("CHAIN_REJECTED");
            for(int i=0;i<simple.Count;i++) { Element element=Read<Element>(Marshal.ReadIntPtr(simple.Elements,i*IntPtr.Size)); string key=Key(Bytes(element.Certificate)); if(element.Trust.Error!=0 || !supplied.Contains(key) || (i==simple.Count-1 && !rootKeys.Contains(key))) throw new Reject("CHAIN_REJECTED"); }
            CheckPolicy(new IntPtr(1),chain,IntPtr.Zero);
            IntPtr ssl=Marshal.AllocHGlobal((int)Size<SslPara>()); allocations.Add(ssl); Marshal.StructureToPtr(new SslPara {Size=Size<SslPara>(),Auth=2},ssl,false); CheckPolicy(new IntPtr(4),chain,ssl);
        } finally { if(chain!=IntPtr.Zero) CertFreeCertificateChain(chain); if(engine!=IntPtr.Zero) CertFreeCertificateChainEngine(engine); foreach(IntPtr p in contexts) CertFreeCertificateContext(p); if(peerStore!=IntPtr.Zero) CertCloseStore(peerStore,0); if(rootStore!=IntPtr.Zero) CertCloseStore(rootStore,0); foreach(IntPtr p in allocations) Marshal.FreeHGlobal(p); }
    }
    static void CheckPolicy(IntPtr policy,IntPtr chain,IntPtr extra) { var para=new PolicyPara {Size=Size<PolicyPara>(),Extra=extra}; var status=new PolicyStatus {Size=Size<PolicyStatus>()}; if(!CertVerifyCertificateChainPolicy(policy,chain,ref para,ref status) || status.Error!=0) throw new Reject("CHAIN_REJECTED"); }
}
