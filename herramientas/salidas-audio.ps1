# Dice por que dispositivos de Windows esta sonando algo ahora mismo, y cual es
# el predeterminado. Sirve para cazar audio que sale por donde no debe: el
# 04/10/2026 el directo sonaba por los altavoces Realtek (Nexo caia ahi cuando
# ASIO4ALL tenia tomado el predeterminado) y se colaba por los micros.
#
#   powershell -ExecutionPolicy Bypass -File herramientas\salidas-audio.ps1 [-Segundos 3]
param([int]$Segundos = 3)
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class NxEnumCom {}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INxEnum { int EnumAudioEndpoints(int flow, int mask, out INxCol c); int GetDefaultAudioEndpoint(int flow, int role, out INxDev d); }
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INxCol { int GetCount(out int n); int Item(int i, out INxDev d); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INxDev { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); int OpenPropertyStore(int access, out INxPS s); int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id); }
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INxPS { int GetCount(out int n); int GetAt(int i, out NxPK k); int GetValue(ref NxPK k, out NxPV v); }
[StructLayout(LayoutKind.Sequential)] struct NxPK { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Explicit)] struct NxPV { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INxMgr { int a(); int b(); int GetSessionEnumerator(out INxSesEnum e); }
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INxSesEnum { int GetCount(out int n); int GetSession(int i, [MarshalAs(UnmanagedType.IUnknown)] out object s); }
[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INxSes { int GetState(out int s); int b(); int c(); int d(); int e(); int f(); int g(); int h(); int i(); int j(); int k(); int GetProcessId(out uint pid); }
[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INxMeter { int GetPeakValue(out float v); }
public static class NxAudio {
  // flujo 0 = salidas, 1 = entradas. Una linea por programa que SUENA en cada dispositivo.
  public static List<string> Ver(int flujo, int decimas) {
    var r = new List<string>(); var e = (INxEnum)new NxEnumCom();
    INxDev def; string defId = ""; if (e.GetDefaultAudioEndpoint(flujo, 0, out def) == 0) def.GetId(out defId);
    INxCol c; e.EnumAudioEndpoints(flujo, 1, out c); int n; c.GetCount(out n);
    for (int i = 0; i < n; i++) {
      INxDev d; c.Item(i, out d); string id; d.GetId(out id);
      INxPS s; d.OpenPropertyStore(0, out s); var k = new NxPK { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 }; NxPV v; s.GetValue(ref k, out v);
      string nombre = Marshal.PtrToStringUni(v.p); string marca = id == defId ? "[PREDET] " : "         ";
      var iid = typeof(INxMgr).GUID; object o; var quien = new List<string>();
      if (d.Activate(ref iid, 23, IntPtr.Zero, out o) == 0) {
        INxSesEnum se; ((INxMgr)o).GetSessionEnumerator(out se); int m; se.GetCount(out m);
        for (int j = 0; j < m; j++) {
          object so; se.GetSession(j, out so); uint pid; ((INxSes)so).GetProcessId(out pid);
          float max = 0; var me = (INxMeter)so;
          for (int t = 0; t < decimas; t++) { float p; me.GetPeakValue(out p); if (p > max) max = p; System.Threading.Thread.Sleep(100 / Math.Max(1, m)); }
          if (max < 0.0005f) continue;
          string pn = "?"; try { pn = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
          quien.Add(String.Format("{0} ({1:0.000})", pn, max));
        }
      }
      r.Add(marca + nombre + (quien.Count > 0 ? "  <- SUENA: " + String.Join(", ", quien) : "  (en silencio)"));
    }
    return r;
  }
}
'@
Write-Host 'SALIDAS'; [NxAudio]::Ver(0, $Segundos * 10) | ForEach-Object { Write-Host "  $_" }
Write-Host 'ENTRADAS'; [NxAudio]::Ver(1, $Segundos * 10) | ForEach-Object { Write-Host "  $_" }
