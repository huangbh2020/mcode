/**
 * Windows Credential Manager bridge for Antigravity (`gemini:antigravity`).
 *
 * Uses PowerShell + P/Invoke (`advapi32.dll` `CredReadW` / `CredWriteW`) so
 * Mcode needs no native C++ addon. Secret payloads are exchanged via base64
 * over stdin/stdout (never in process argv).
 */
import { spawn } from "node:child_process";

const TARGET_NAME = "gemini:antigravity";

const READ_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class McodeWinCredRead {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credPtr);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr credPtr);
  public static string ReadBase64(string target) {
    IntPtr ptr;
    if (!CredReadW(target, 1, 0, out ptr)) {
      int err = Marshal.GetLastWin32Error();
      if (err == 1168) return "";
      throw new Exception("CredReadW failed with win32 error " + err);
    }
    try {
      var cred = Marshal.PtrToStructure<CREDENTIAL>(ptr);
      if (cred.CredentialBlobSize == 0 || cred.CredentialBlob == IntPtr.Zero) return "";
      byte[] buf = new byte[cred.CredentialBlobSize];
      Marshal.Copy(cred.CredentialBlob, buf, 0, (int)cred.CredentialBlobSize);
      return Convert.ToBase64String(buf);
    } finally {
      CredFree(ptr);
    }
  }
}
"@
[Console]::Out.Write([McodeWinCredRead]::ReadBase64('${TARGET_NAME}'))
`;

const WRITE_PS = `
$ErrorActionPreference = 'Stop'
$b64 = [Console]::In.ReadToEnd().Trim()
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class McodeWinCredWrite {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWriteW(ref CREDENTIAL cred, uint flags);
  public static void WriteBase64(string target, string b64) {
    byte[] bytes = Convert.FromBase64String(b64);
    IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      var cred = new CREDENTIAL {
        Flags = 0,
        Type = 1,
        TargetName = target,
        CredentialBlobSize = (uint)bytes.Length,
        CredentialBlob = blob,
        Persist = 2,
        UserName = Environment.UserName
      };
      if (!CredWriteW(ref cred, 0)) {
        throw new Exception("CredWriteW failed with win32 error " + Marshal.GetLastWin32Error());
      }
    } finally {
      Marshal.FreeHGlobal(blob);
    }
  }
}
"@
[McodeWinCredWrite]::WriteBase64('${TARGET_NAME}', $b64)
`;

function runPowerShell(script: string, stdinData?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Windows Credential Manager operation timed out"));
    }, 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });

    if (stdinData !== undefined) {
      child.stdin.write(stdinData, "utf8");
    }
    child.stdin.end();
  });
}

/** Read raw `gemini:antigravity` credential blob as base64, or null when not signed in. */
export async function readAntigravityWindowsCredentialBase64(): Promise<string | null> {
  if (process.platform !== "win32") {
    throw new Error("当前仅支持在 Windows 上自动捕获并切换 Google OAuth 凭据快照");
  }
  const b64 = await runPowerShell(READ_PS);
  return b64.length > 0 ? b64 : null;
}

/** Write a saved base64 credential blob back to Windows Credential Manager. */
export async function writeAntigravityWindowsCredentialBase64(b64: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("当前仅支持在 Windows 上切换 Google OAuth 凭据快照");
  }
  await runPowerShell(WRITE_PS, b64);
}

/** Best-effort extract an email hint from a UTF-8 JSON credential payload. */
export function extractEmailHintFromCredentialBase64(b64: string): string | undefined {
  try {
    const text = Buffer.from(b64, "base64").toString("utf8");
    const match = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(text);
    return match?.[0];
  } catch {
    return undefined;
  }
}
