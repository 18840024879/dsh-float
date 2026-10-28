using System;
using System.Diagnostics;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

/*
 * Detects double clicks that land on a dsh-pet window and reports them to the
 * dsh-float helper over its loopback bridge. The pet window is normally
 * mouse-transparent and only accepts the pointer while the cursor hovers the
 * pet body, so WindowFromPoint() is a reliable "clicked the pet" test. Single
 * clicks (and the press that starts a pet drag) are ignored on purpose.
 */
internal static class PetWatch
{
    private const int VK_LBUTTON = 0x01;
    private const uint GA_ROOT = 2;
    private const int SM_CXDOUBLECLK = 36;
    private const int SM_CYDOUBLECLK = 37;

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")]
    private static extern uint GetDoubleClickTime();

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    private static int port;
    private static int epoch;
    private static string token;

    private static void Main()
    {
        try { SetProcessDPIAware(); }
        catch { }

        port = ReadIntEnv("DSH_FLOAT_BRIDGE_PORT");
        epoch = ReadIntEnv("DSH_FLOAT_EPOCH");
        token = Environment.GetEnvironmentVariable("DSH_FLOAT_BRIDGE_TOKEN") ?? "";
        int helperPid = ReadIntEnv("DSH_FLOAT_HELPER_PID");
        if (port <= 0 || token.Length == 0 || helperPid <= 0)
        {
            Log("missing bridge settings");
            return;
        }

        Process helper;
        try { helper = Process.GetProcessById(helperPid); }
        catch
        {
            Log("helper not running");
            return;
        }

        Log("watching pet double clicks on port " + port.ToString());
        bool previousDown = false;
        long lastParentCheck = 0;
        long lastClickAt = -1;
        long suppressUntil = 0;
        POINT lastClick;
        lastClick.X = 0;
        lastClick.Y = 0;
        int clickWidth = Math.Max(GetSystemMetrics(SM_CXDOUBLECLK), 2);
        int clickHeight = Math.Max(GetSystemMetrics(SM_CYDOUBLECLK), 2);
        long doubleClickMs = GetDoubleClickTime();
        if (doubleClickMs <= 0) doubleClickMs = 500;
        Stopwatch clock = Stopwatch.StartNew();

        while (true)
        {
            if (clock.ElapsedMilliseconds - lastParentCheck >= 500)
            {
                lastParentCheck = clock.ElapsedMilliseconds;
                try
                {
                    if (helper.HasExited) break;
                }
                catch
                {
                    break;
                }
            }

            bool down = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
            if (down && !previousDown)
            {
                long now = clock.ElapsedMilliseconds;
                if (now >= suppressUntil)
                {
                    POINT point;
                    if (GetCursorPos(out point) && IsPetAt(point))
                    {
                        bool secondClick = lastClickAt >= 0 &&
                            now - lastClickAt <= doubleClickMs &&
                            Math.Abs(point.X - lastClick.X) <= clickWidth &&
                            Math.Abs(point.Y - lastClick.Y) <= clickHeight;
                        if (secondClick)
                        {
                            lastClickAt = -1;
                            if (Post("pet.dblclick"))
                            {
                                suppressUntil = now + doubleClickMs;
                                Log("pet double click at " + point.X + "," + point.Y);
                            }
                        }
                        else
                        {
                            lastClickAt = now;
                            lastClick = point;
                        }
                    }
                    else
                    {
                        lastClickAt = -1;
                    }
                }
            }
            previousDown = down;
            Thread.Sleep(30);
        }
        Log("helper gone, exiting");
    }

    private static bool IsPetAt(POINT point)
    {
        IntPtr hit = WindowFromPoint(point);
        if (hit == IntPtr.Zero) return false;
        IntPtr root = GetAncestor(hit, GA_ROOT);
        if (root == IntPtr.Zero || !IsWindowVisible(root)) return false;

        StringBuilder title = new StringBuilder(256);
        GetWindowText(root, title, title.Capacity);
        if (title.ToString().IndexOf("dsh-pet", StringComparison.OrdinalIgnoreCase) < 0) return false;

        StringBuilder cls = new StringBuilder(256);
        GetClassName(root, cls, cls.Capacity);
        if (cls.ToString() != "Chrome_WidgetWin_1") return false;

        uint pid;
        GetWindowThreadProcessId(root, out pid);
        if (pid == 0) return false;
        try
        {
            return Process.GetProcessById((int)pid).ProcessName == "electron";
        }
        catch
        {
            return false;
        }
    }

    private static bool Post(string type)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port.ToString() + "/bridge");
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Headers.Add("x-dsh-float-token", token);
            request.Timeout = 1200;
            request.ReadWriteTimeout = 1200;
            request.Proxy = null;
            request.KeepAlive = false;

            byte[] body = Encoding.UTF8.GetBytes("{\"type\":\"" + type + "\",\"epoch\":" + epoch.ToString() + "}");
            request.ContentLength = body.Length;
            using (System.IO.Stream stream = request.GetRequestStream())
            {
                stream.Write(body, 0, body.Length);
            }
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                return (int)response.StatusCode == 200;
            }
        }
        catch (Exception error)
        {
            Log("post failed: " + error.GetType().Name);
            return false;
        }
    }

    private static int ReadIntEnv(string name)
    {
        int value;
        if (int.TryParse(Environment.GetEnvironmentVariable(name), out value)) return value;
        return 0;
    }

    private static void Log(string message)
    {
        try
        {
            Console.Error.WriteLine(message);
            Console.Error.Flush();
        }
        catch
        {
        }
    }
}
