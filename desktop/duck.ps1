# Dad Net: turn Discord down while the radio talks.
# The app starts this once and sends it one line at a time:
#   duck <percent>   Discord's slider in the Windows Volume Mixer goes to that
#                    much of where it was (0 = muted). Asked again, it just changes
#                    the amount.
#   restore          put Discord back exactly where it was
#   status           how many Discord sound streams there are right now
# It answers every line with "ok <count>" or "err <what went wrong>".
# When the app goes away (even if it crashes), Discord is put back first.
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace DadNet {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCo {}

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  }
  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IMMDevice device);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }
  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
  }
  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName(out IntPtr name);
    [PreserveSig] int SetDisplayName(IntPtr value, IntPtr context);
    [PreserveSig] int GetIconPath(out IntPtr path);
    [PreserveSig] int SetIconPath(IntPtr value, IntPtr context);
    [PreserveSig] int GetGroupingParam(out Guid group);
    [PreserveSig] int SetGroupingParam(IntPtr group, IntPtr context);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int GetSessionIdentifier(out IntPtr id);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
    [PreserveSig] int GetProcessId(out uint pid);
  }
  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, ref Guid context);
    [PreserveSig] int GetMasterVolume(out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }

  public static class Ducker {
    static readonly Dictionary<string, float> savedLevel = new Dictionary<string, float>();
    static readonly Dictionary<string, bool> savedMute = new Dictionary<string, bool>();
    static Guid ctx = Guid.Empty;

    // Every Discord sound stream on every speaker/headset that's plugged in.
    static List<KeyValuePair<string, ISimpleAudioVolume>> Discord() {
      var list = new List<KeyValuePair<string, ISimpleAudioVolume>>();
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCo());
      IMMDeviceCollection devs;
      if (en.EnumAudioEndpoints(0 /* playback */, 1 /* active */, out devs) != 0) return list;
      int n; devs.GetCount(out n);
      Guid iid = typeof(IAudioSessionManager2).GUID;
      for (int i = 0; i < n; i++) {
        IMMDevice dev; if (devs.Item(i, out dev) != 0) continue;
        object o; if (dev.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o) != 0) continue;
        var mgr = (IAudioSessionManager2)o;
        IAudioSessionEnumerator sessions; if (mgr.GetSessionEnumerator(out sessions) != 0) continue;
        int c; sessions.GetCount(out c);
        for (int j = 0; j < c; j++) {
          IAudioSessionControl2 s; if (sessions.GetSession(j, out s) != 0 || s == null) continue;
          uint pid; s.GetProcessId(out pid);
          if (pid == 0) continue;
          string name;
          try { name = Process.GetProcessById((int)pid).ProcessName; } catch { continue; }
          if (!name.StartsWith("Discord", StringComparison.OrdinalIgnoreCase)) continue;
          string id = i + ":" + pid + ":" + j;
          IntPtr p;
          if (s.GetSessionInstanceIdentifier(out p) == 0 && p != IntPtr.Zero) { id = Marshal.PtrToStringUni(p); Marshal.FreeCoTaskMem(p); }
          var v = s as ISimpleAudioVolume;
          if (v != null) list.Add(new KeyValuePair<string, ISimpleAudioVolume>(id, v));
        }
      }
      return list;
    }

    public static string Duck(int percent) {
      int count = 0;
      foreach (var kv in Discord()) {
        float level; bool mute;
        kv.Value.GetMasterVolume(out level); kv.Value.GetMute(out mute);
        if (!savedLevel.ContainsKey(kv.Key)) { savedLevel[kv.Key] = level; savedMute[kv.Key] = mute; }
        if (percent <= 0) kv.Value.SetMute(true, ref ctx);
        else {
          if (!savedMute[kv.Key]) kv.Value.SetMute(false, ref ctx);
          kv.Value.SetMasterVolume(Math.Max(0f, Math.Min(1f, savedLevel[kv.Key] * percent / 100f)), ref ctx);
        }
        count++;
      }
      return "ok " + count;
    }

    public static string Restore() {
      int count = 0;
      foreach (var kv in Discord()) {
        if (!savedLevel.ContainsKey(kv.Key)) continue;
        kv.Value.SetMasterVolume(savedLevel[kv.Key], ref ctx);
        kv.Value.SetMute(savedMute[kv.Key], ref ctx);
        count++;
      }
      savedLevel.Clear(); savedMute.Clear();
      return "ok " + count;
    }

    public static string Status() { return "ok " + Discord().Count; }
  }
}
'@
try {
  Add-Type -TypeDefinition $code -Language CSharp
  [Console]::Out.WriteLine('ready')
} catch {
  [Console]::Out.WriteLine('err ' + $_.Exception.Message)
  exit 1
}
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }   # the app went away
  $line = $line.Trim()
  try {
    if ($line -match '^duck (\d{1,3})$') { $r = [DadNet.Ducker]::Duck([int]$Matches[1]) }
    elseif ($line -eq 'restore') { $r = [DadNet.Ducker]::Restore() }
    elseif ($line -eq 'status') { $r = [DadNet.Ducker]::Status() }
    elseif ($line -eq 'quit') { break }
    else { $r = 'err unknown command' }
  } catch { $r = 'err ' + $_.Exception.Message }
  [Console]::Out.WriteLine($r)
  [Console]::Out.Flush()
}
try { [DadNet.Ducker]::Restore() | Out-Null } catch {}
