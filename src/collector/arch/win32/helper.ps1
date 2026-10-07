# helper.ps1 - the Windows collector's resident READ-ONLY helper (RFC 4.8 sections 1, 5.3, 10.1). Client: helper.mjs.
#
# One PowerShell process per daemon, started as the user at Medium integrity. It reads, answers over JSON lines, and writes nothing: no
# registry write, no file write, no process control, no network. The verbs are a closed set (the switch in Dispatch); helper.mjs refuses
# anything else before it is written, and test/collector/arch/win32/helper.test.mjs scans this file for write verbs and keeps both lists equal.
# ASCII only: Windows PowerShell 5.1 reads a script without a byte-order mark in the ANSI code page.
#
# Protocol, one JSON object per line each way:
#   helper -> client, once, after the native code is compiled:  {"ready":true,"proto":1,"pid":N,"ps":"5.1...","native":true}
#   client -> helper:  {"id":N,"verb":"ps","args":{...}}        helper -> client:  {"id":N,"ok":true,"data":{...}} | {"id":N,"ok":false,"error":"..."}
# EOF on stdin ends the loop. Verbs: version ps tcp-table reg-read net-if route token roots pipe-server (what each returns: section 1 of 4.8).
#
# Windows PowerShell 5.1, C# 5 (Add-Type compiles with the .NET Framework compiler: no string interpolation, no ?., no out var).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:Proto = 1

# The native half. Every method here only reads: a process snapshot (Toolhelp32), image path / start time / session / token integrity through
# PROCESS_QUERY_LIMITED_INFORMATION (which opens across integrity levels), the TCP owner-pid table, the best route for an address (a table
# lookup, nothing is sent), and the server pid of a named pipe. JSON for the big answers is built here: ConvertTo-Json is slow on thousands of rows.
$cs = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public class AsightProc {
  public int Pid; public int Ppid; public int Session; public int Rid; public long StartedMs;
  public string Name; public string Exe; public bool TokenDenied;
}

public static class AsightWin {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PE32 { public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
  [DllImport("iphlpapi.dll", SetLastError = true)] static extern uint GetExtendedTcpTable(IntPtr t, ref int size, bool sort, int af, int cls, uint reserved);
  [DllImport("iphlpapi.dll")] static extern uint GetBestInterface(uint dest, out uint index);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder sb, ref int size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid, out uint session);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PE32 pe);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PE32 pe);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeServerProcessId(IntPtr h, out uint pid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr buf, int len, out int returned);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, int n);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

  static readonly string[] States = { "unknown", "closed", "listen", "syn-sent", "syn-received", "established", "fin-wait-1", "fin-wait-2", "close-wait", "closing", "last-ack", "time-wait", "delete-tcb" };
  static int ownSession = -2;

  static string N(long v) { return v.ToString(CultureInfo.InvariantCulture); }
  static void Q(StringBuilder b, string s) {
    if (s == null) { b.Append("null"); return; }
    b.Append('"');
    foreach (char c in s) { if (c == '"') b.Append("\\\""); else if (c == '\\') b.Append("\\\\"); else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4")); else b.Append(c); }
    b.Append('"');
  }
  public static int OwnSession() {
    uint s;
    if (ownSession == -2) ownSession = ProcessIdToSessionId((uint)System.Diagnostics.Process.GetCurrentProcess().Id, out s) ? (int)s : -1;
    return ownSession;
  }
  static string ImagePath(IntPtr h) {
    for (int cap = 1024; cap <= 32768; cap *= 32) {
      StringBuilder sb = new StringBuilder(cap); int size = cap;
      if (QueryFullProcessImageName(h, 0, sb, ref size)) return sb.ToString();
      if (Marshal.GetLastWin32Error() != 122) return null;
    }
    return null;
  }
  static long StartedOf(IntPtr h) {
    long c, e, k, u;
    return (GetProcessTimes(h, out c, out e, out k, out u) && c > 0) ? c / 10000L - 11644473600000L : -1;
  }
  static int TokenRid(IntPtr tok) {
    int need = 0;
    GetTokenInformation(tok, 25, IntPtr.Zero, 0, out need);
    if (need <= 0) return -1;
    IntPtr buf = Marshal.AllocHGlobal(need);
    try {
      if (!GetTokenInformation(tok, 25, buf, need, out need)) return -1;
      IntPtr sid = Marshal.ReadIntPtr(buf);
      return Marshal.ReadInt32(GetSidSubAuthority(sid, Marshal.ReadByte(GetSidSubAuthorityCount(sid)) - 1));
    } finally { Marshal.FreeHGlobal(buf); }
  }
  static int TokenDword(IntPtr tok, int cls) {
    IntPtr buf = Marshal.AllocHGlobal(4);
    try { int ret; return GetTokenInformation(tok, cls, buf, 4, out ret) ? Marshal.ReadInt32(buf) : -1; } finally { Marshal.FreeHGlobal(buf); }
  }
  // the integrity RID of a process's token; denied = the token could not be opened (a higher integrity level, or another user's process)
  static int RidOfProcess(IntPtr proc, out bool denied) {
    IntPtr tok; denied = !OpenProcessToken(proc, 0x8, out tok);
    if (denied) return -1;
    try { return TokenRid(tok); } finally { CloseHandle(tok); }
  }
  public static string IntegrityNameOf(int rid) {
    return rid < 0 ? null : rid < 0x1000 ? "untrusted" : rid < 0x2000 ? "low" : rid < 0x3000 ? "medium" : rid < 0x4000 ? "high" : rid < 0x5000 ? "system" : "protected";
  }

  // the processes of this session (all = every session), without command lines: those come from CIM and are merged in ProcsJson
  public static List<AsightProc> Snapshot(bool all) {
    List<AsightProc> res = new List<AsightProc>();
    int own = OwnSession();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) throw new InvalidOperationException("CreateToolhelp32Snapshot failed: " + Marshal.GetLastWin32Error());
    try {
      PE32 pe = new PE32(); pe.dwSize = (uint)Marshal.SizeOf(typeof(PE32));
      if (!Process32FirstW(snap, ref pe)) return res;
      do {
        int pid = (int)pe.th32ProcessID;
        if (pid == 0) continue;
        uint sess; int sid = ProcessIdToSessionId((uint)pid, out sess) ? (int)sess : -1;
        if (!all && sid != own) continue;
        AsightProc p = new AsightProc(); p.Pid = pid; p.Ppid = (int)pe.th32ParentProcessID; p.Name = pe.szExeFile; p.Session = sid; p.StartedMs = -1; p.Rid = -1;
        IntPtr h = OpenProcess(0x1000, false, pid);
        if (h != IntPtr.Zero) {
          try { p.Exe = ImagePath(h); p.StartedMs = StartedOf(h); bool denied; p.Rid = RidOfProcess(h, out denied); p.TokenDenied = denied; } finally { CloseHandle(h); }
        }
        res.Add(p);
      } while (Process32NextW(snap, ref pe));
    } finally { CloseHandle(snap); }
    return res;
  }

  public static string ProcsJson(List<AsightProc> list, Dictionary<int, string> cmd) {
    StringBuilder b = new StringBuilder("{\"sessionId\":" + N(OwnSession()) + ",\"procs\":[");
    foreach (AsightProc p in list) {
      string c = null;
      if (cmd != null) cmd.TryGetValue(p.Pid, out c);
      if (b[b.Length - 1] != '[') b.Append(',');
      b.Append("{\"pid\":" + N(p.Pid) + ",\"ppid\":" + N(p.Ppid) + ",\"name\":"); Q(b, p.Name);
      b.Append(",\"exe\":"); Q(b, p.Exe);
      b.Append(",\"cmdline\":"); Q(b, c);
      b.Append(",\"startedAt\":" + (p.StartedMs >= 0 ? N(p.StartedMs) : "null") + ",\"sessionId\":" + (p.Session >= 0 ? N(p.Session) : "null") + ",\"integrity\":"); Q(b, IntegrityNameOf(p.Rid));
      b.Append(",\"tokenDenied\":" + (p.Exe != null && p.TokenDenied ? "true" : "false") + "}");
    }
    return b.Append("]}").ToString();
  }

  // own token: {elevated, elevation type, integrity RID}
  public static int[] TokenInfo() {
    IntPtr tok;
    if (!OpenProcessToken(GetCurrentProcess(), 0x8, out tok)) throw new InvalidOperationException("OpenProcessToken failed: " + Marshal.GetLastWin32Error());
    try { return new int[] { TokenDword(tok, 20), TokenDword(tok, 18), TokenRid(tok) }; } finally { CloseHandle(tok); }
  }

  // the TCP rows (IPv4 and IPv6, every state) that match the filters; an empty / zero filter matches everything. Either family unreadable = an error
  public static string TcpJson(int[] pids, int remotePort, int localPort, string[] states) {
    HashSet<int> pidSet = (pids != null && pids.Length > 0) ? new HashSet<int>(pids) : null;
    HashSet<string> stSet = (states != null && states.Length > 0) ? new HashSet<string>(states) : null;
    StringBuilder b = new StringBuilder("{\"rows\":[");
    foreach (int af in new int[] { 2, 23 }) {
      int size = 0, tries = 0; IntPtr buf = IntPtr.Zero; uint rc;
      GetExtendedTcpTable(IntPtr.Zero, ref size, false, af, 5, 0);
      try {
        do {
          if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
          size += 4096; buf = Marshal.AllocHGlobal(size);
          rc = GetExtendedTcpTable(buf, ref size, false, af, 5, 0);
        } while (rc == 122 && ++tries < 6);
        if (rc != 0) throw new InvalidOperationException("GetExtendedTcpTable af=" + af + " rc=" + rc);
        int n = Marshal.ReadInt32(buf); int rowSize = af == 2 ? 24 : 56; IntPtr row = buf + 4;
        for (int i = 0; i < n; i++, row += rowSize) {
          int pid, st, lp, rp; string la, ra;
          if (af == 2) {
            st = Marshal.ReadInt32(row, 0); la = new System.Net.IPAddress((uint)Marshal.ReadInt32(row, 4)).ToString(); lp = (Marshal.ReadByte(row, 8) << 8) | Marshal.ReadByte(row, 9);
            ra = new System.Net.IPAddress((uint)Marshal.ReadInt32(row, 12)).ToString(); rp = (Marshal.ReadByte(row, 16) << 8) | Marshal.ReadByte(row, 17); pid = Marshal.ReadInt32(row, 20);
          } else {
            byte[] x = new byte[16]; Marshal.Copy(row, x, 0, 16); la = new System.Net.IPAddress(x).ToString(); lp = (Marshal.ReadByte(row, 20) << 8) | Marshal.ReadByte(row, 21);
            byte[] y = new byte[16]; Marshal.Copy(row + 24, y, 0, 16); ra = new System.Net.IPAddress(y).ToString(); rp = (Marshal.ReadByte(row, 44) << 8) | Marshal.ReadByte(row, 45);
            st = Marshal.ReadInt32(row, 48); pid = Marshal.ReadInt32(row, 52);
          }
          string sn = (st >= 1 && st < States.Length) ? States[st] : States[0];
          if ((pidSet != null && !pidSet.Contains(pid)) || (remotePort > 0 && rp != remotePort) || (localPort > 0 && lp != localPort) || (stSet != null && !stSet.Contains(sn))) continue;
          if (b[b.Length - 1] != '[') b.Append(',');
          b.Append("{\"pid\":" + N(pid) + ",\"state\":\"" + sn + "\",\"family\":" + (af == 2 ? "4" : "6") + ",\"localAddr\":"); Q(b, la);
          b.Append(",\"localPort\":" + N(lp) + ",\"remoteAddr\":"); Q(b, ra); b.Append(",\"remotePort\":" + N(rp) + "}");
        }
      } finally { if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf); }
    }
    return b.Append("]}").ToString();
  }

  // the interface a packet to this IPv4 address would leave by (a routing-table lookup; nothing is sent), -1 when there is none
  public static int BestInterface(string dest) {
    uint idx;
    return GetBestInterface(BitConverter.ToUInt32(System.Net.IPAddress.Parse(dest).GetAddressBytes(), 0), out idx) == 0 ? (int)idx : -1;
  }

  // a named pipe: does it exist, and which process serves it. Opening it as a client (read access, sends nothing) is the only way to ask.
  public static string PipeJson(string name) {
    StringBuilder b = new StringBuilder();
    IntPtr h = CreateFile("\\\\.\\pipe\\" + name, 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) { int e = Marshal.GetLastWin32Error(); return "{\"exists\":" + (e == 2 ? "false" : "true") + ",\"win32Error\":" + N(e) + ",\"serverPid\":null,\"exe\":null,\"startedAt\":null}"; }
    try {
      uint spid;
      if (!GetNamedPipeServerProcessId(h, out spid)) return "{\"exists\":true,\"serverPid\":null,\"exe\":null,\"startedAt\":null,\"win32Error\":" + N(Marshal.GetLastWin32Error()) + "}";
      string exe = null; long started = -1;
      IntPtr p = OpenProcess(0x1000, false, (int)spid);
      if (p != IntPtr.Zero) { try { exe = ImagePath(p); started = StartedOf(p); } finally { CloseHandle(p); } }
      b.Append("{\"exists\":true,\"serverPid\":" + N(spid) + ",\"exe\":"); Q(b, exe);
      return b.Append(",\"startedAt\":" + (started >= 0 ? N(started) : "null") + "}").ToString();
    } finally { CloseHandle(h); }
  }
}
'@

$script:native = $true
$script:nativeError = $null
try { Add-Type -TypeDefinition $cs -ErrorAction Stop } catch { $script:native = $false; $script:nativeError = [string]$_.Exception.Message }

$utf8 = New-Object System.Text.UTF8Encoding($false)
$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$out.NewLine = "`n"
$out.AutoFlush = $true
function Send([string]$s) { $out.WriteLine($s) }
function Need-Native { if (-not $script:native) { throw ('native-unavailable: ' + $script:nativeError) } }

# command lines come from CIM Win32_Process (readable at Medium for the user's own processes). Asked once per process (key = pid:start), at most three
# times when the answer is empty (a process this young may not have one yet); after a CIM failure not again for 30 s.
$script:cmdCache = @{}
$script:cmdTries = @{}
$script:cimRetryAt = [DateTime]::MinValue

function Verb-Version($a) {
  $o = [ordered]@{ proto = $script:Proto; pid = $PID; ps = $PSVersionTable.PSVersion.ToString(); os = [Environment]::OSVersion.Version.ToString(); native = $script:native }
  if ($script:nativeError) { $o.nativeError = $script:nativeError }
  if ($script:native) { $o.sessionId = [AsightWin]::OwnSession() }
  return $o
}

function Verb-Ps($a) {
  Need-Native
  $all = ($null -ne $a.all) -and [bool]$a.all
  $want = -not (($null -ne $a.cmdline) -and (-not [bool]$a.cmdline))
  $list = [AsightWin]::Snapshot($all)
  $dict = New-Object 'System.Collections.Generic.Dictionary[int,string]'
  $live = @{}
  $need = New-Object 'System.Collections.Generic.List[int]'
  foreach ($p in $list) {
    $k = "$($p.Pid):$($p.StartedMs)"
    $live[$k] = $true
    if ($null -ne $script:cmdCache[$k]) { $dict[$p.Pid] = [string]$script:cmdCache[$k] }
    elseif ($want -and ([int]$script:cmdTries[$k] -lt 3)) { $need.Add($p.Pid) }
  }
  if ($need.Count -gt 0 -and [DateTime]::UtcNow -ge $script:cimRetryAt) {
    try {
      if ($need.Count -le 40) {
        $f = (($need | ForEach-Object { 'ProcessId=' + $_ }) -join ' or ')
        $rows = @(Get-CimInstance -ClassName Win32_Process -Filter $f -Property ProcessId, CommandLine)
      } else {
        $rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, CommandLine)
      }
      $got = @{}
      foreach ($r in $rows) { $got[[int]$r.ProcessId] = $r.CommandLine }
      foreach ($p in $list) {
        if (-not $need.Contains($p.Pid)) { continue }
        $k = "$($p.Pid):$($p.StartedMs)"
        $c = $got[$p.Pid]
        if ($c -is [string] -and $c.Length -gt 0) { $script:cmdCache[$k] = $c; $dict[$p.Pid] = $c }
        else { $script:cmdTries[$k] = [int]$script:cmdTries[$k] + 1 }
      }
    } catch { $script:cimRetryAt = [DateTime]::UtcNow.AddSeconds(30) }
  }
  foreach ($k in @($script:cmdCache.Keys)) { if (-not $live.ContainsKey($k)) { $script:cmdCache.Remove($k) } }
  foreach ($k in @($script:cmdTries.Keys)) { if (-not $live.ContainsKey($k)) { $script:cmdTries.Remove($k) } }
  return @{ __raw = [AsightWin]::ProcsJson($list, $dict) }
}

function Verb-TcpTable($a) {
  Need-Native
  $pids = @()
  if ($null -ne $a.pids) { $pids = @($a.pids | ForEach-Object { [int]$_ }) }
  $states = @()
  if ($null -ne $a.states) { $states = @($a.states | ForEach-Object { [string]$_ }) }
  return @{ __raw = [AsightWin]::TcpJson([int[]]$pids, [int]$a.remotePort, [int]$a.localPort, [string[]]$states) }
}

function Get-IfList {
  $list = @()
  foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    $addrs = @(); $gws = @(); $idx = $null
    try {
      $ip = $n.GetIPProperties()
      foreach ($u in $ip.UnicastAddresses) { $addrs += ($u.Address.ToString() + '/' + $u.PrefixLength) }
      foreach ($g in $ip.GatewayAddresses) { $gws += $g.Address.ToString() }
      try { $idx = $ip.GetIPv4Properties().Index } catch { $idx = $null }
    } catch { $idx = $null }
    $list += [ordered]@{ id = $n.Id; name = $n.Name; description = $n.Description; type = $n.NetworkInterfaceType.ToString(); up = ($n.OperationalStatus.ToString() -eq 'Up'); index = $idx; addrs = @($addrs); gateways = @($gws) }
  }
  return @($list)
}

function Verb-NetIf($a) {
  return [ordered]@{ interfaces = @(Get-IfList) }
}

function Verb-Route($a) {
  Need-Native
  $dest = '1.1.1.1'
  if ($null -ne $a.dest) { $dest = [string]$a.dest }
  if ($dest -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { throw 'bad-dest' }
  $idx = [AsightWin]::BestInterface($dest)
  $hit = $null
  foreach ($i in @(Get-IfList)) { if ($null -ne $i.index -and $i.index -eq $idx) { $hit = $i } }
  $ifIndex = $null
  if ($idx -ge 0) { $ifIndex = $idx }
  $iface = $null
  if ($null -ne $hit) { $iface = $hit }
  return [ordered]@{ dest = $dest; ifIndex = $ifIndex; iface = $iface }
}

function Verb-Token($a) {
  Need-Native
  $t = [AsightWin]::TokenInfo()
  $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $type = $null
  if ($t[1] -eq 1) { $type = 'default' } elseif ($t[1] -eq 2) { $type = 'full' } elseif ($t[1] -eq 3) { $type = 'limited' }
  return [ordered]@{ pid = $PID; elevated = (($t[0] -eq 1) -or ($t[2] -ge 12288)); elevationType = $type; integrity = [AsightWin]::IntegrityNameOf($t[2]); system = [bool]$id.IsSystem; sessionId = [AsightWin]::OwnSession() }
}

function Verb-PipeServer($a) {
  Need-Native
  $name = [string]$a.name
  if ($name -notmatch '^[A-Za-z0-9._-]{1,128}$') { throw 'bad-pipe-name' }
  return @{ __raw = [AsightWin]::PipeJson($name) }
}

function Dispatch([string]$verb, $a) {
  switch ($verb) {
    'version' { return (Verb-Version $a) }
    'ps' { return (Verb-Ps $a) }
    'tcp-table' { return (Verb-TcpTable $a) }
    'net-if' { return (Verb-NetIf $a) }
    'route' { return (Verb-Route $a) }
    'token' { return (Verb-Token $a) }
    'pipe-server' { return (Verb-PipeServer $a) }
    default { throw ('unknown-verb: ' + $verb) }
  }
}

$info = [ordered]@{ ready = $true; proto = $script:Proto; pid = $PID; ps = $PSVersionTable.PSVersion.ToString(); native = $script:native }
if ($script:nativeError) { $info.nativeError = $script:nativeError }
Send (ConvertTo-Json -InputObject $info -Compress)

while ($true) {
  $line = $in.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = $null
  try {
    $req = ConvertFrom-Json -InputObject $line
    $id = [int]$req.id
    $a = $req.args
    if ($null -eq $a) { $a = New-Object PSObject }
    $r = Dispatch ([string]$req.verb) $a
    if (($r -is [hashtable]) -and $r.ContainsKey('__raw')) { $data = [string]$r['__raw'] } else { $data = ConvertTo-Json -InputObject $r -Compress -Depth 6 }
    Send ('{"id":' + $id + ',"ok":true,"data":' + $data + '}')
  } catch {
    $idText = 'null'
    if ($null -ne $id) { $idText = [string]$id }
    Send ('{"id":' + $idText + ',"ok":false,"error":' + (ConvertTo-Json -InputObject ([string]$_.Exception.Message) -Compress) + '}')
  }
}
