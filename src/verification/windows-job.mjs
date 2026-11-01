import {
  VERIFY_STATUS,
  VERIFY_DISPATCH_MS,
  VERIFY_POLL_MS,
  VERIFY_DRAIN_MS,
  VERIFY_START_PHASE,
  VERIFY_WINDOWS_FLAGS,
} from "../shared/constants.mjs";
// Windows verification uses a kill-on-close Job Object, assigned before the
// command's first instruction. Descendants remain in the job after parents exit.
export const WINDOWS_JOB_SCRIPT = String.raw`
param([string]$Recipe,[string]$Cancel,[string]$Report,[string]$Ready,[string]$Go,[string]$Phase)
$ErrorActionPreference='Stop'
[IO.File]::WriteAllText($Phase,'${VERIFY_START_PHASE.COMPILING}')
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
public static class VerificationJob {
 [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
  public long ProcessTime,JobTime; public uint Flags;
  public UIntPtr Min,Max; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling;
 }
 [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct Extended { public BasicLimit Basic; public Io Io; public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long a,b,c,d; public uint Faults,Total,Active,Terminated; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
  public uint cb; public string reserved,desktop,title; public uint x,y,xs,ys,xc,yc,fill,flags;
  public ushort show,reserved2; public IntPtr reservedPtr,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Extended info,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,uint size,IntPtr length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string exe,StringBuilder args,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo info);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
 static void Check(bool ok) { if(!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
 public static string Quote(string value) {
  var b=new StringBuilder("\"");
  int slashes=0;
  foreach(char c in value) {
   if(c=='\\') {
    slashes++;
    continue;
   }
   if(c=='"') {
    b.Append('\\',slashes*2+1);
    b.Append(c);
   } else {
    b.Append('\\',slashes);
    b.Append(c);
   }
   slashes=0;
  }
  b.Append('\\',slashes*2);
  b.Append('"');
  return b.ToString();
 }
 public static void Run(string exe,string[] args,string cwd,int timeout,string cancel,string report,string ready,string go,string phase,string completionKey) {
  byte[] key=Convert.FromBase64String(completionKey);
  if(key.Length!=32)throw new Exception("invalid completion key");
  File.WriteAllText(phase,"${VERIFY_START_PHASE.JOB}");
  IntPtr job=CreateJobObject(IntPtr.Zero,null);
  if(job==IntPtr.Zero)Check(false);
  ProcessInfo process=new ProcessInfo();
  bool assigned=false;
  try {
   Extended limit=new Extended();
   limit.Basic.Flags=${VERIFY_WINDOWS_FLAGS.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
   Check(SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(typeof(Extended))));
   Startup startup=new Startup();
   startup.cb=(uint)Marshal.SizeOf(typeof(Startup));
   startup.flags=${VERIFY_WINDOWS_FLAGS.STARTF_USESTDHANDLES};
   startup.input=GetStdHandle(-10);
   startup.output=GetStdHandle(-11);
   startup.error=GetStdHandle(-12);
   var line=new StringBuilder(Quote(exe));
   foreach(string arg in args)line.Append(" "+Quote(arg));
   File.WriteAllText(phase,"${VERIFY_START_PHASE.COMMAND}");
   Check(CreateProcess(exe,line,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref startup,out process));
   File.WriteAllText(phase,"${VERIFY_START_PHASE.ASSIGN}");
   Check(AssignProcessToJobObject(job,process.process));
   assigned=true;
   long birth=Process.GetProcessById((int)process.pid).StartTime.ToUniversalTime().Ticks;
   File.WriteAllText(ready+".tmp","{\"pid\":"+process.pid+",\"processStart\":\""+birth+"\"}");
   File.Move(ready+".tmp",ready);
   File.WriteAllText(phase,"${VERIFY_START_PHASE.READY}");
   Stopwatch gate=Stopwatch.StartNew();
   while(!File.Exists(go)&&!File.Exists(cancel)) {
    if(gate.ElapsedMilliseconds>${VERIFY_DISPATCH_MS})throw new Exception("verification dispatch not confirmed");
    Thread.Sleep(${VERIFY_POLL_MS});
   }
   Stopwatch clock=Stopwatch.StartNew();
   string status=File.Exists(cancel)?"${VERIFY_STATUS.CANCELLED}":"exited";
   uint code=0;
   if(status=="exited" && ResumeThread(process.thread)==0xffffffff)Check(false);
   File.WriteAllText(phase,"${VERIFY_START_PHASE.RUNNING}");
   while(status=="exited"){
    if(File.Exists(cancel)) {
     status=File.ReadAllText(cancel).Trim()=="timeout"?"timeout":"${VERIFY_STATUS.CANCELLED}";
     break;
    }
    if(clock.ElapsedMilliseconds>=timeout) {
     status="timeout";
     break;
    }
    uint wait=WaitForSingleObject(process.process,(uint)Math.Max(1,Math.Min(50,timeout-clock.ElapsedMilliseconds)));
    if(File.Exists(cancel)) {
     status=File.ReadAllText(cancel).Trim()=="timeout"?"timeout":"${VERIFY_STATUS.CANCELLED}";
     break;
    }
    if(clock.ElapsedMilliseconds>=timeout) {
     status="timeout";
     break;
    }
    if(wait==0)break;
    if(wait!=258)Check(false);
   }
   if(status=="exited")Check(GetExitCodeProcess(process.process,out code));
   Check(TerminateJobObject(job,1));
   Stopwatch drain=Stopwatch.StartNew();
   Accounting active;
   for(;;) {
    Check(QueryInformationJobObject(job,1,out active,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
    if(active.Active==0)break;
    if(drain.ElapsedMilliseconds>${VERIFY_DRAIN_MS})throw new Exception("job descendants did not stop");
    Thread.Sleep(${VERIFY_POLL_MS});
   }
   string payload=Convert.ToBase64String(Encoding.UTF8.GetBytes("{\"state\":\""+status+"\",\"code\":"+code+",\"durationMs\":"+clock.ElapsedMilliseconds+",\"settled\":true}"));
   string proof;
   using(var signer=new HMACSHA256(key)) {
    proof=BitConverter.ToString(signer.ComputeHash(Encoding.UTF8.GetBytes(payload))).Replace("-","").ToLowerInvariant();
   }
   File.WriteAllText(report,"{\"payload\":\""+payload+"\",\"proof\":\""+proof+"\"}");
  } finally {
   if(process.process!=IntPtr.Zero && !assigned)TerminateProcess(process.process,1);
   CloseHandle(job);
   if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);
   if(process.process!=IntPtr.Zero)CloseHandle(process.process);
  }
 }
}
'@
[IO.File]::WriteAllText($Phase,'${VERIFY_START_PHASE.RECIPE}')
$task = Get-Content -LiteralPath $Recipe -Raw -Encoding UTF8 | ConvertFrom-Json
[IO.File]::WriteAllText($Phase,'${VERIFY_START_PHASE.KEY}')
$completionKey = [Console]::In.ReadLine()
[VerificationJob]::Run($task.executable,[string[]]$task.args,$task.cwd,[int]$task.timeoutMs,$Cancel,$Report,$Ready,$Go,$Phase,$completionKey)
`;
