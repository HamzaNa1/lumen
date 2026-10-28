param(
    [Parameter(Mandatory=$true)][long]$WindowHandle,
    [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;
using System.Windows.Forms;
public static class PresentationProbe {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Thumbnail {
        public uint Flags; public Rect Destination; public Rect Source; public byte Opacity;
        [MarshalAs(UnmanagedType.Bool)] public bool Visible;
        [MarshalAs(UnmanagedType.Bool)] public bool ClientOnly;
    }
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect bounds);
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")] static extern int DwmRegisterThumbnail(IntPtr destination, IntPtr source, out IntPtr thumbnail);
    [DllImport("dwmapi.dll")] static extern int DwmUpdateThumbnailProperties(IntPtr thumbnail, ref Thumbnail properties);
    [DllImport("dwmapi.dll")] static extern int DwmUnregisterThumbnail(IntPtr thumbnail);
    [DllImport("dwmapi.dll")] static extern int DwmFlush();
    static void Wait(Func<bool> condition, string message) {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!condition()) {
            if (DateTime.UtcNow >= deadline) {
                var title = new StringBuilder(256);
                var foreground = GetForegroundWindow();
                GetWindowText(foreground, title, title.Capacity);
                throw new Exception(message + "; foreground=" + foreground + " (" + title + ")");
            }
            Application.DoEvents(); Thread.Sleep(20);
        }
    }
    static void AltTab(Action whileHeld) {
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        try {
            keybd_event(0x09, 0, 0, UIntPtr.Zero);
            keybd_event(0x09, 0, 2, UIntPtr.Zero);
            if (whileHeld != null) whileHeld();
        } finally { keybd_event(0x12, 0, 2, UIntPtr.Zero); }
    }
    static bool Capture(Rectangle bounds, string path, bool requireVideo) {
        using (var bitmap = new Bitmap(bounds.Width, bounds.Height)) {
            using (var graphics = Graphics.FromImage(bitmap))
                graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
            int red = 0;
            for (int y = bounds.Height / 4; y < bounds.Height * 3 / 4; y += 4)
                for (int x = bounds.Width / 4; x < bounds.Width * 3 / 4; x += 4) {
                    var pixel = bitmap.GetPixel(x, y);
                    if (pixel.R > 200 && pixel.G < 40 && pixel.B < 40) red++;
                }
            bitmap.Save(path, ImageFormat.Png);
            return !requireVideo || red > 100;
        }
    }
    static Rectangle Bounds(IntPtr window) {
        Rect bounds;
        if (!GetWindowRect(window, out bounds)) throw new Exception("Cannot read native window bounds");
        return Rectangle.FromLTRB(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom);
    }
    public static void Run(long handle, string directory) {
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        var window = new IntPtr(handle);
        ShowWindow(window, 9); SetForegroundWindow(window);
        Wait(() => GetForegroundWindow() == window, "Playback window did not take focus");
        Wait(() => Capture(Bounds(window), System.IO.Path.Combine(directory, "native-window.png"), true), "Native playback capture has no video");
        ShowWindow(window, 6);
        Wait(() => IsIconic(window), "Window did not minimize");
        ShowWindow(window, 9); SetForegroundWindow(window);
        Wait(() => !IsIconic(window) && GetForegroundWindow() == window, "Window did not restore");
        Wait(() => Capture(Bounds(window), System.IO.Path.Combine(directory, "native-restored.png"), true), "Restored window has no video");
        // DWM's thumbnail surface is independent of Chromium's capturePage API.
        using (var preview = new Form()) {
            preview.Text = "Lumen DWM thumbnail test";
            preview.ClientSize = new Size(640, 400);
            preview.StartPosition = FormStartPosition.CenterScreen;
            preview.BackColor = Color.Black;
            preview.Show(); Application.DoEvents();
            IntPtr thumbnail;
            if (DwmRegisterThumbnail(preview.Handle, window, out thumbnail) != 0)
                throw new Exception("DWM thumbnail registration failed");
            try {
                var properties = new Thumbnail { Flags = 1 | 4 | 8 | 16,
                    Destination = new Rect { Right = 640, Bottom = 400 },
                    Opacity = 255, Visible = true, ClientOnly = false };
                if (DwmUpdateThumbnailProperties(thumbnail, ref properties) != 0)
                    throw new Exception("DWM thumbnail update failed");
                Wait(() => { Application.DoEvents(); DwmFlush(); return Capture(
                    preview.RectangleToScreen(preview.ClientRectangle),
                    System.IO.Path.Combine(directory, "native-thumbnail.png"), true);
                }, "Windows thumbnail has no video");
            } finally { DwmUnregisterThumbnail(thumbnail); }
            // Windows may select the owning console instead of this form. Wait for
            // another application, excluding Explorer's transient task switcher.
            preview.Activate();
            Wait(() => GetForegroundWindow() == preview.Handle, "Thumbnail window did not take focus");
            SetForegroundWindow(window);
            Wait(() => GetForegroundWindow() == window, "Cannot prepare Alt+Tab");
            AltTab(() => {
                // Sample the OS animation with Alt held for visual inspection.
                Thread.Sleep(350); DwmFlush();
                Capture(Screen.FromHandle(window).Bounds, System.IO.Path.Combine(directory, "native-alt-tab.png"), false);
            });
            uint shellProcess;
            GetWindowThreadProcessId(GetShellWindow(), out shellProcess);
            Wait(() => {
                var foreground = GetForegroundWindow();
                uint foregroundProcess;
                GetWindowThreadProcessId(foreground, out foregroundProcess);
                return foreground != IntPtr.Zero && foreground != window && foregroundProcess != shellProcess;
            }, "Alt+Tab did not switch away from playback");
            AltTab(null);
            Wait(() => GetForegroundWindow() == window, "Playback did not return after Alt+Tab");
            Wait(() => Capture(Bounds(window), System.IO.Path.Combine(directory, "native-after-alt-tab.png"), true), "Video did not return after Alt+Tab");
            preview.Close();
        }
    }
}
'@
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
[PresentationProbe]::Run($WindowHandle, $OutputDirectory)
