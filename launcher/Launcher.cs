using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace MadMarathonMenuLauncher
{
    internal static class Program
    {
        private const string ProductTitle = "Конструктор меню";
        private const string RuntimeExeName = "Конструктор меню.exe";
        private const string ResourceSuffix = "app.zip";

        [STAThread]
        private static void Main()
        {
            string[] args = Environment.GetCommandLineArgs();
            if (args.Length > 1 && UpdaterMode.TryRun(args))
            {
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SplashForm(ProductTitle));
        }

        internal static void StartApplication(SplashForm splash)
        {
            try
            {
                splash.SetStatus("Подготавливаем приложение...");
                string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
                string runtimeDir = EnsureRuntime(splash);
                string appPath = Path.Combine(runtimeDir, RuntimeExeName);

                splash.SetStatus("Запускаем конструктор...");
                ProcessStartInfo startInfo = new ProcessStartInfo(appPath);
                startInfo.WorkingDirectory = baseDir;
                startInfo.UseShellExecute = false;
                startInfo.Arguments = BuildForwardedArguments();
                startInfo.EnvironmentVariables["PORTABLE_EXECUTABLE_DIR"] = baseDir;
                startInfo.EnvironmentVariables["PORTABLE_EXECUTABLE_FILE"] = Assembly.GetExecutingAssembly().Location;

                Process appProcess = Process.Start(startInfo);
                WaitForMainWindow(appProcess);
                splash.CloseSafe();
            }
            catch (Exception ex)
            {
                splash.ShowError(ex);
            }
        }

        private static string EnsureRuntime(SplashForm splash)
        {
            string hash = GetRuntimeHash();
            string runtimeRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "MadMarathon",
                "MenuConstructor",
                "runtime"
            );
            string targetDir = Path.Combine(runtimeRoot, hash);
            string targetExe = Path.Combine(targetDir, RuntimeExeName);

            if (File.Exists(targetExe))
            {
                CleanupOldRuntimeDirs(runtimeRoot, hash);
                return targetDir;
            }

            Directory.CreateDirectory(runtimeRoot);
            string tempDir = targetDir + ".tmp";
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, true);
            Directory.CreateDirectory(tempDir);

            ExtractRuntime(tempDir, splash);

            if (Directory.Exists(targetDir)) Directory.Delete(targetDir, true);
            Directory.Move(tempDir, targetDir);
            CleanupOldRuntimeDirs(runtimeRoot, hash);
            return targetDir;
        }

        private static void ExtractRuntime(string targetDir, SplashForm splash)
        {
            using (Stream stream = OpenRuntimeResource())
            using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                int total = archive.Entries.Count;
                int current = 0;
                string safeRoot = Path.GetFullPath(targetDir) + Path.DirectorySeparatorChar;

                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    current++;
                    string fullPath = Path.GetFullPath(Path.Combine(targetDir, entry.FullName));
                    if (!fullPath.StartsWith(safeRoot, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidOperationException("Unsafe archive entry: " + entry.FullName);
                    }

                    if (String.IsNullOrEmpty(entry.Name))
                    {
                        Directory.CreateDirectory(fullPath);
                    }
                    else
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(fullPath));
                        entry.ExtractToFile(fullPath, true);
                    }

                    if (current == 1 || current == total || current % 4 == 0)
                    {
                        int percent = total == 0 ? 100 : (current * 100 / total);
                        splash.SetStatus("Распаковываем приложение... " + percent + "%");
                    }
                }
            }
        }

        private static string GetRuntimeHash()
        {
            using (Stream stream = OpenRuntimeResource())
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(stream);
                return BitConverter.ToString(hash).Replace("-", "").Substring(0, 16).ToLowerInvariant();
            }
        }

        private static Stream OpenRuntimeResource()
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            foreach (string name in assembly.GetManifestResourceNames())
            {
                if (name.EndsWith(ResourceSuffix, StringComparison.OrdinalIgnoreCase))
                {
                    Stream stream = assembly.GetManifestResourceStream(name);
                    if (stream != null) return stream;
                }
            }

            throw new FileNotFoundException("Embedded runtime archive was not found.");
        }

        private static void CleanupOldRuntimeDirs(string runtimeRoot, string currentHash)
        {
            try
            {
                foreach (string dir in Directory.GetDirectories(runtimeRoot))
                {
                    if (!String.Equals(Path.GetFileName(dir), currentHash, StringComparison.OrdinalIgnoreCase))
                    {
                        Directory.Delete(dir, true);
                    }
                }
            }
            catch
            {
                // Old runtime can be locked by another running copy; it is safe to leave it.
            }
        }

        private static void WaitForMainWindow(Process process)
        {
            if (process == null) return;

            DateTime deadline = DateTime.Now.AddSeconds(60);
            while (!process.HasExited && DateTime.Now < deadline)
            {
                process.Refresh();
                if (process.MainWindowHandle != IntPtr.Zero)
                {
                    Thread.Sleep(350);
                    return;
                }

                Thread.Sleep(100);
            }
        }

        private static string BuildForwardedArguments()
        {
            string[] args = Environment.GetCommandLineArgs();
            if (args.Length <= 1) return String.Empty;

            StringBuilder builder = new StringBuilder();
            for (int i = 1; i < args.Length; i++)
            {
                if (builder.Length > 0) builder.Append(' ');
                builder.Append(QuoteArgument(args[i]));
            }

            return builder.ToString();
        }

        private static string QuoteArgument(string arg)
        {
            if (String.IsNullOrEmpty(arg)) return "\"\"";
            if (arg.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return arg;
            return "\"" + arg.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }
    }

    internal static class UpdaterMode
    {
        private const string ApplyArg = "--apply-update";
        private const string WorkerArg = "--apply-update-worker";

        internal static bool TryRun(string[] args)
        {
            if (args == null || args.Length < 2) return false;

            if (String.Equals(args[1], ApplyArg, StringComparison.OrdinalIgnoreCase))
            {
                StartWorker(args);
                return true;
            }

            if (String.Equals(args[1], WorkerArg, StringComparison.OrdinalIgnoreCase))
            {
                RunWorker(args);
                return true;
            }

            return false;
        }

        private static void StartWorker(string[] args)
        {
            if (args.Length < 7) return;

            string tempUpdater = Path.Combine(Path.GetTempPath(), "mad-marathon-menu-updater.exe");
            string currentExe = Assembly.GetExecutingAssembly().Location;
            File.Copy(currentExe, tempUpdater, true);

            ProcessStartInfo startInfo = new ProcessStartInfo(tempUpdater);
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.WorkingDirectory = Path.GetDirectoryName(args[4]);
            startInfo.Arguments = JoinArguments(new string[]
            {
                WorkerArg,
                args[2],
                args[3],
                args[4],
                args[5],
                args[6]
            });

            Process.Start(startInfo);
        }

        private static void RunWorker(string[] args)
        {
            if (args.Length < 7) return;

            int appPid = 0;
            Int32.TryParse(args[2], out appPid);
            string downloadPath = args[3];
            string targetPath = args[4];
            string backupPath = args[5];
            string logPath = args[6];

            int exitCode = 1;
            WriteLog(logPath, "native updater started");
            WriteLog(logPath, "download=" + downloadPath);
            WriteLog(logPath, "target=" + targetPath);

            try
            {
                WaitForProcessExit(appPid, logPath);

                if (!File.Exists(downloadPath))
                {
                    throw new FileNotFoundException("Downloaded update file was not found.", downloadPath);
                }

                long downloadSize = new FileInfo(downloadPath).Length;
                for (int attempt = 1; attempt <= 40; attempt++)
                {
                    try
                    {
                        WriteLog(logPath, "copy attempt " + attempt);

                        if (File.Exists(targetPath))
                        {
                            File.Copy(targetPath, backupPath, true);
                        }

                        File.Copy(downloadPath, targetPath, true);
                        long targetSize = new FileInfo(targetPath).Length;
                        if (targetSize != downloadSize)
                        {
                            throw new IOException("Size mismatch after copy.");
                        }

                        exitCode = 0;
                        WriteLog(logPath, "copy completed");
                        break;
                    }
                    catch (Exception ex)
                    {
                        WriteLog(logPath, "copy attempt failed: " + ex.Message);
                        Thread.Sleep(1000);
                    }
                }

                if (exitCode != 0)
                {
                    throw new IOException("Unable to replace launcher.");
                }

                StartUpdatedApplication(targetPath);
                WriteLog(logPath, "restarted updated application");
            }
            catch (Exception ex)
            {
                WriteLog(logPath, "native updater failed: " + ex.Message);

                try
                {
                    if (File.Exists(backupPath))
                    {
                        File.Copy(backupPath, targetPath, true);
                    }
                }
                catch (Exception restoreError)
                {
                    WriteLog(logPath, "restore failed: " + restoreError.Message);
                }

                try
                {
                    if (File.Exists(targetPath))
                    {
                        StartUpdatedApplication(targetPath);
                    }
                }
                catch (Exception restartError)
                {
                    WriteLog(logPath, "restart after failure failed: " + restartError.Message);
                }
            }
            finally
            {
                if (exitCode == 0)
                {
                    TryDelete(downloadPath);
                    TryDelete(backupPath);
                }
                else
                {
                    WriteLog(logPath, "update files were kept for diagnostics");
                }

                ScheduleSelfDelete(logPath);
            }
        }

        private static void WaitForProcessExit(int appPid, string logPath)
        {
            if (appPid <= 0) return;

            WriteLog(logPath, "waiting for app pid " + appPid);
            DateTime deadline = DateTime.Now.AddSeconds(120);
            while (DateTime.Now < deadline)
            {
                try
                {
                    Process process = Process.GetProcessById(appPid);
                    if (process.HasExited) break;
                }
                catch
                {
                    break;
                }

                Thread.Sleep(500);
            }

            WriteLog(logPath, "app process released");
        }

        private static void StartUpdatedApplication(string targetPath)
        {
            ProcessStartInfo startInfo = new ProcessStartInfo(targetPath);
            startInfo.WorkingDirectory = Path.GetDirectoryName(targetPath);
            startInfo.UseShellExecute = false;
            Process.Start(startInfo);
        }

        private static void WriteLog(string logPath, string message)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(logPath));
                string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + Environment.NewLine;
                File.AppendAllText(logPath, line, Encoding.UTF8);
            }
            catch
            {
                // Diagnostics must never block the updater.
            }
        }

        private static void TryDelete(string filePath)
        {
            try
            {
                if (File.Exists(filePath)) File.Delete(filePath);
            }
            catch
            {
            }
        }

        private static void ScheduleSelfDelete(string logPath)
        {
            try
            {
                string selfPath = Assembly.GetExecutingAssembly().Location;
                if (!selfPath.StartsWith(Path.GetTempPath(), StringComparison.OrdinalIgnoreCase)) return;

                string command = "/C ping 127.0.0.1 -n 3 > nul & del /F /Q " + QuoteForCmd(selfPath);
                ProcessStartInfo startInfo = new ProcessStartInfo("cmd.exe", command);
                startInfo.CreateNoWindow = true;
                startInfo.UseShellExecute = false;
                Process.Start(startInfo);
            }
            catch (Exception ex)
            {
                WriteLog(logPath, "self cleanup failed: " + ex.Message);
            }
        }

        private static string JoinArguments(string[] args)
        {
            StringBuilder builder = new StringBuilder();
            foreach (string arg in args)
            {
                if (builder.Length > 0) builder.Append(' ');
                builder.Append(QuoteArgument(arg));
            }

            return builder.ToString();
        }

        private static string QuoteArgument(string arg)
        {
            if (String.IsNullOrEmpty(arg)) return "\"\"";
            return "\"" + arg.Replace("\"", "\\\"") + "\"";
        }

        private static string QuoteForCmd(string value)
        {
            return "\"" + value.Replace("\"", "\"\"") + "\"";
        }
    }

    internal sealed class SplashForm : Form
    {
        private readonly System.Windows.Forms.Timer animationTimer;
        private readonly Image logoImage;
        private readonly string titleText;
        private string statusText = "Запускаем...";
        private int animationOffset;

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int width, int height);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr handle);

        public SplashForm(string title)
        {
            titleText = title;
            Text = title;
            Width = 560;
            Height = 360;
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.None;
            BackColor = Color.FromArgb(17, 16, 24);
            ForeColor = Color.White;
            TopMost = true;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);

            logoImage = LoadLogo();

            animationTimer = new System.Windows.Forms.Timer();
            animationTimer.Interval = 16;
            animationTimer.Tick += delegate
            {
                animationOffset = (animationOffset + 5) % 420;
                Invalidate(new Rectangle(132, 276, 296, 34));
            };
            animationTimer.Start();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            IntPtr rounded = CreateRoundRectRgn(0, 0, Width + 1, Height + 1, 30, 30);
            Region = Region.FromHrgn(rounded);
            DeleteObject(rounded);
            ThreadPool.QueueUserWorkItem(delegate { Program.StartApplication(this); });
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            e.Graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            e.Graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;

            using (LinearGradientBrush brush = new LinearGradientBrush(
                ClientRectangle,
                Color.FromArgb(28, 26, 40),
                Color.FromArgb(12, 11, 18),
                LinearGradientMode.ForwardDiagonal))
            {
                e.Graphics.FillRectangle(brush, ClientRectangle);
            }

            using (GraphicsPath path = new GraphicsPath())
            {
                path.AddEllipse(80, -140, 400, 300);
                using (PathGradientBrush glow = new PathGradientBrush(path))
                {
                    glow.CenterColor = Color.FromArgb(70, 255, 93, 134);
                    glow.SurroundColors = new Color[] { Color.FromArgb(0, 255, 93, 134) };
                    e.Graphics.FillPath(glow, path);
                }
            }

            using (Pen border = new Pen(Color.FromArgb(42, 255, 255, 255), 1))
            {
                e.Graphics.DrawRectangle(border, 0, 0, Width - 1, Height - 1);
            }

            DrawLogo(e.Graphics);
            DrawCenteredText(e.Graphics, titleText, new Font("Segoe UI", 28, FontStyle.Bold, GraphicsUnit.Point), Color.White, new RectangleF(20, 184, ClientSize.Width - 40, 46));
            DrawCenteredText(e.Graphics, statusText, new Font("Segoe UI", 11, FontStyle.Regular, GraphicsUnit.Point), Color.FromArgb(210, 205, 224), new RectangleF(20, 236, ClientSize.Width - 40, 28));

            Rectangle bar = new Rectangle(140, 286, 280, 8);
            using (GraphicsPath track = RoundedRect(bar, 8))
            using (SolidBrush trackBrush = new SolidBrush(Color.FromArgb(34, 255, 255, 255)))
            {
                e.Graphics.FillPath(trackBrush, track);
            }

            Rectangle runner = new Rectangle(bar.Left - 120 + animationOffset, bar.Top, 128, bar.Height);
            using (GraphicsPath runnerClip = RoundedRect(bar, 8))
            using (LinearGradientBrush runnerBrush = new LinearGradientBrush(
                runner,
                Color.FromArgb(0, 255, 93, 134),
                Color.FromArgb(255, 255, 209, 220),
                LinearGradientMode.Horizontal))
            {
                e.Graphics.SetClip(runnerClip);
                e.Graphics.FillRectangle(runnerBrush, runner);
                e.Graphics.ResetClip();
            }

            base.OnPaint(e);
        }

        public void SetStatus(string text)
        {
            if (IsDisposed) return;
            if (InvokeRequired)
            {
                BeginInvoke(new Action<string>(SetStatus), text);
                return;
            }

            statusText = text;
            Invalidate(new Rectangle(20, 236, ClientSize.Width - 40, 28));
        }

        public void CloseSafe()
        {
            if (IsDisposed) return;
            if (InvokeRequired)
            {
                BeginInvoke(new Action(CloseSafe));
                return;
            }

            Close();
        }

        public void ShowError(Exception ex)
        {
            if (IsDisposed) return;
            if (InvokeRequired)
            {
                BeginInvoke(new Action<Exception>(ShowError), ex);
                return;
            }

            statusText = "Не удалось запустить приложение";
            Invalidate();
            MessageBox.Show(this, ex.Message, "Ошибка запуска", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && animationTimer != null)
            {
                animationTimer.Stop();
                animationTimer.Dispose();
                if (logoImage != null) logoImage.Dispose();
            }

            base.Dispose(disposing);
        }

        private void DrawLogo(Graphics graphics)
        {
            if (logoImage == null) return;

            Rectangle target = FitImage(logoImage.Size, new Rectangle(110, 30, 340, 154));
            graphics.DrawImage(logoImage, target);
        }

        private static void DrawCenteredText(Graphics graphics, string text, Font font, Color color, RectangleF rect)
        {
            using (font)
            using (SolidBrush brush = new SolidBrush(color))
            using (StringFormat format = new StringFormat())
            {
                format.Alignment = StringAlignment.Center;
                format.LineAlignment = StringAlignment.Center;
                format.Trimming = StringTrimming.EllipsisCharacter;
                graphics.DrawString(text, font, brush, rect, format);
            }
        }

        private static Image LoadLogo()
        {
            try
            {
                string logoPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "templates", "logo.png");
                if (!File.Exists(logoPath)) return null;
                byte[] bytes = File.ReadAllBytes(logoPath);
                using (MemoryStream stream = new MemoryStream(bytes))
                {
                    using (Image image = Image.FromStream(stream))
                    {
                        return new Bitmap(image);
                    }
                }
            }
            catch
            {
                return null;
            }
        }

        private static Rectangle FitImage(Size imageSize, Rectangle bounds)
        {
            if (imageSize.Width <= 0 || imageSize.Height <= 0) return bounds;

            double scale = Math.Min((double)bounds.Width / imageSize.Width, (double)bounds.Height / imageSize.Height);
            int width = Math.Max(1, (int)Math.Round(imageSize.Width * scale));
            int height = Math.Max(1, (int)Math.Round(imageSize.Height * scale));
            int x = bounds.Left + (bounds.Width - width) / 2;
            int y = bounds.Top + (bounds.Height - height) / 2;
            return new Rectangle(x, y, width, height);
        }

        private static GraphicsPath RoundedRect(Rectangle rect, int radius)
        {
            int diameter = radius * 2;
            GraphicsPath path = new GraphicsPath();
            path.AddArc(rect.Left, rect.Top, diameter, diameter, 180, 90);
            path.AddArc(rect.Right - diameter, rect.Top, diameter, diameter, 270, 90);
            path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rect.Left, rect.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }
    }
}
