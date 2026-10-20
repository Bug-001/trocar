// trocar install-folder wrapper (spec 4.11 P8; lab W3). Compiled by `trocar install` with the
// inbox .NET Framework csc.exe and written where the agent's program was; the program itself was moved to .trocar-real\ beside it under the
// same name. Without the switch file: the certificate variable is set only when it is unset, and the real program runs with the same command
// line (the tail after argv[0], verbatim: no re-quoting can change an argument), the inherited std handles, and its exit code is ours.
// With the switch file: TROCAR_PRIOR_PROXY records the agent's own proxy (the first set name of its precedence list that is not the door;
// "none" when none is set) and the agent's proxy names point at the door the switch file holds. The child is in a job that kills it when the
// wrapper is killed (an editor's TerminateProcess must not orphan it); Ctrl-C / Ctrl-Break are ignored by the wrapper only, the child decides.
using System; using System.IO; using System.Text; using System.Runtime.InteropServices;
static class TrocarWrapper {
  const string Real = __TROCAR_REAL__, Switch = __TROCAR_SWITCH__, CaFile = __TROCAR_CA_FILE__, CertVar = __TROCAR_CERT_VAR__;
  static readonly string[] ProxyEnv = __TROCAR_PROXY_ENV__, ProxyNames = __TROCAR_PROXY_NAMES__;
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SI { public int cb; public string r, d, t; public int x, y, xs, ys, xc, yc, fill, flags; public short show, r2; public IntPtr r3, hin, hout, herr; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr hp, ht; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct JBLI { public long a, b; public int flags; public IntPtr c, d; public int e; public IntPtr f; public int g, h; }
  [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct JELI { public JBLI basic; public IOC io; public IntPtr pm, jm, ppu, pju; }
  delegate bool CtrlHandler(int type);
  [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, int flags, IntPtr env, string dir, ref SI si, out PI pi);
  [DllImport("kernel32")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32")] static extern int WaitForSingleObject(IntPtr h, int ms);
  [DllImport("kernel32")] static extern bool GetExitCodeProcess(IntPtr h, out int code);
  [DllImport("kernel32")] static extern int ResumeThread(IntPtr h);
  [DllImport("kernel32")] static extern bool SetConsoleCtrlHandler(CtrlHandler h, bool add);
  [DllImport("kernel32")] static extern int GetConsoleProcessList(int[] list, int n);
  [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr a, string name);
  [DllImport("kernel32")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JELI info, int len);
  [DllImport("kernel32")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  static CtrlHandler keep; // the delegate must outlive Main's frame
  static string Get(string n) { var v = Environment.GetEnvironmentVariable(n); return string.IsNullOrEmpty(v) ? null : v; }
  static string Tail(string cl) { // the command line after argv[0], verbatim (argv[0] is parsed the way CommandLineToArgvW does)
    int i = 0; while (i < cl.Length && (cl[i] == ' ' || cl[i] == '\t')) i++;
    if (i < cl.Length && cl[i] == '"') { i = cl.IndexOf('"', i + 1); i = i < 0 ? cl.Length : i + 1; } else { while (i < cl.Length && cl[i] != ' ' && cl[i] != '\t') i++; }
    while (i < cl.Length && (cl[i] == ' ' || cl[i] == '\t')) i++;
    return cl.Substring(i);
  }
  static void Route() {
    string door = null;
    try { if (File.Exists(Switch)) { var t = File.ReadAllText(Switch); int nl = t.IndexOfAny(new[] { '\r', '\n' }); door = nl < 0 ? t : t.Substring(0, nl); } } catch { door = null; }
    if (string.IsNullOrEmpty(door)) return;
    string prior = null; bool sawDoor = false;
    foreach (var n in ProxyEnv) { var v = Get(n); if (v == null) continue; if (v != door) { prior = v; break; } sawDoor = true; }
    if (prior != null) Environment.SetEnvironmentVariable("TROCAR_PRIOR_PROXY", prior);
    else if (!sawDoor || Get("TROCAR_PRIOR_PROXY") == null) Environment.SetEnvironmentVariable("TROCAR_PRIOR_PROXY", "none");
    foreach (var n in ProxyNames) Environment.SetEnvironmentVariable(n, door);
  }
  static int Main() {
    if (Get(CertVar) == null) Environment.SetEnvironmentVariable(CertVar, CaFile);
    Route();
    string tail = Tail(Environment.CommandLine), cmd = "\"" + Real + "\"" + (tail.Length > 0 ? " " + tail : "");
    keep = t => t == 0 || t == 1; SetConsoleCtrlHandler(keep, true);
    bool hasConsole = GetConsoleProcessList(new int[4], 4) > 0;
    var si = new SI(); si.cb = Marshal.SizeOf(typeof(SI)); si.flags = 0x100 /*STARTF_USESTDHANDLES*/; si.hin = GetStdHandle(-10); si.hout = GetStdHandle(-11); si.herr = GetStdHandle(-12);
    int flags = 0x400 /*UNICODE_ENVIRONMENT*/ | 0x4 /*CREATE_SUSPENDED*/ | (hasConsole ? 0 : 0x08000000 /*CREATE_NO_WINDOW*/);
    PI pi;
    if (!CreateProcessW(Real, new StringBuilder(cmd, 32768), IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, null, ref si, out pi)) {
      Console.Error.WriteLine("trocar wrapper: could not start " + Real + " (error " + Marshal.GetLastWin32Error() + "); run `trocar install` again, or reinstall the program");
      return 9009;
    }
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null); var info = new JELI(); info.basic.flags = 0x2000 /*KILL_ON_JOB_CLOSE*/ | 0x1000 /*SILENT_BREAKAWAY_OK*/;
    if (job != IntPtr.Zero && SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(JELI)))) AssignProcessToJobObject(job, pi.hp);
    ResumeThread(pi.ht);
    WaitForSingleObject(pi.hp, -1); int code; GetExitCodeProcess(pi.hp, out code); return code;
  }
}
