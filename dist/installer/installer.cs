using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Windows.Forms;

namespace Ps5PluginHub
{
    public class InstallerForm : Form
    {
        private TextBox txtPath;
        private Button btnBrowse;
        private CheckBox chkDesktop;
        private CheckBox chkStartMenu;
        private Button btnInstall;
        private Button btnCancel;
        private ProgressBar progress;
        private Label lblStatus;
        private bool installing = false;

        private static string AppName { get { return InstallLogic.AppName; } }
        private static string AppDirName { get { return InstallLogic.AppDirName; } }

        public InstallerForm()
        {
            this.Text = AppName + " - 安装程序";
            this.Width = 520;
            this.Height = 360;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.MinimizeBox = false;
            this.Font = new Font("Microsoft YaHei UI", 9F);

            int y = 20;

            Label lblTitle = new Label();
            lblTitle.Text = AppName;
            lblTitle.Font = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold);
            lblTitle.AutoSize = true;
            lblTitle.Left = 20;
            lblTitle.Top = y;
            this.Controls.Add(lblTitle);
            y += 45;

            Label lblSub = new Label();
            lblSub.Text = "选择安装目录，创建快捷方式，然后点击安装。";
            lblSub.AutoSize = true;
            lblSub.Left = 20;
            lblSub.Top = y;
            lblSub.ForeColor = Color.Gray;
            this.Controls.Add(lblSub);
            y += 40;

            Label lblPath = new Label();
            lblPath.Text = "安装目录:";
            lblPath.AutoSize = true;
            lblPath.Left = 20;
            lblPath.Top = y;
            this.Controls.Add(lblPath);
            y += 28;

            txtPath = new TextBox();
            txtPath.Left = 20;
            txtPath.Top = y;
            txtPath.Width = 370;
            txtPath.Text = InstallLogic.DefaultInstallDir;
            this.Controls.Add(txtPath);

            btnBrowse = new Button();
            btnBrowse.Text = "浏览...";
            btnBrowse.Left = 400;
            btnBrowse.Top = y - 3;
            btnBrowse.Width = 80;
            btnBrowse.Click += new EventHandler(btnBrowse_Click);
            this.Controls.Add(btnBrowse);
            y += 45;

            chkDesktop = new CheckBox();
            chkDesktop.Text = "创建桌面快捷方式";
            chkDesktop.Left = 20;
            chkDesktop.Top = y;
            chkDesktop.Width = 200;
            chkDesktop.Checked = true;
            this.Controls.Add(chkDesktop);
            y += 30;

            chkStartMenu = new CheckBox();
            chkStartMenu.Text = "创建开始菜单快捷方式";
            chkStartMenu.Left = 20;
            chkStartMenu.Top = y;
            chkStartMenu.Width = 200;
            chkStartMenu.Checked = true;
            this.Controls.Add(chkStartMenu);
            y += 30;

            progress = new ProgressBar();
            progress.Left = 20;
            progress.Top = y;
            progress.Width = 460;
            progress.Height = 18;
            this.Controls.Add(progress);
            y += 28;

            lblStatus = new Label();
            lblStatus.Text = "";
            lblStatus.AutoSize = true;
            lblStatus.Left = 20;
            lblStatus.Top = y;
            lblStatus.ForeColor = Color.DimGray;
            this.Controls.Add(lblStatus);

            btnCancel = new Button();
            btnCancel.Text = "取消";
            btnCancel.Left = 330;
            btnCancel.Top = this.ClientSize.Height - 50;
            btnCancel.Width = 75;
            btnCancel.Click += new EventHandler(btnCancel_Click);
            this.Controls.Add(btnCancel);

            btnInstall = new Button();
            btnInstall.Text = "安装";
            btnInstall.Left = 415;
            btnInstall.Top = this.ClientSize.Height - 50;
            btnInstall.Width = 75;
            btnInstall.Click += new EventHandler(btnInstall_Click);
            this.Controls.Add(btnInstall);

            // Try to set form icon from associated icon
            try
            {
                this.Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
            }
            catch { }
        }

        private void btnBrowse_Click(object sender, EventArgs e)
        {
            using (FolderBrowserDialog dlg = new FolderBrowserDialog())
            {
                dlg.Description = "选择安装目录";
                if (dlg.ShowDialog() == DialogResult.OK)
                {
                    txtPath.Text = Path.Combine(dlg.SelectedPath, AppDirName);
                }
            }
        }

        private void btnCancel_Click(object sender, EventArgs e)
        {
            if (installing)
            {
                if (MessageBox.Show("安装正在进行中，确定要取消吗？", "确认",
                    MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
                    return;
            }
            Application.Exit();
        }

        private void btnInstall_Click(object sender, EventArgs e)
        {
            if (installing) return;
            string installDir = txtPath.Text.Trim();
            if (string.IsNullOrEmpty(installDir))
            {
                MessageBox.Show("请选择安装目录。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            try
            {
                // Test if we can write to the parent
                string parent = Path.GetDirectoryName(installDir);
                if (!string.IsNullOrEmpty(parent) && !Directory.Exists(parent))
                {
                    Directory.CreateDirectory(parent);
                }
                string testFile = Path.Combine(installDir, ".write_test");
                Directory.CreateDirectory(installDir);
                File.WriteAllText(testFile, "test");
                File.Delete(testFile);
            }
            catch
            {
                MessageBox.Show("无法写入该目录，请选择其他目录或使用管理员权限运行。", "错误",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            installing = true;
            btnInstall.Enabled = false;
            btnCancel.Enabled = false;
            btnBrowse.Enabled = false;
            txtPath.ReadOnly = true;
            chkDesktop.Enabled = false;
            chkStartMenu.Enabled = false;
            progress.Style = ProgressBarStyle.Marquee;

            // Run install in background to keep UI responsive
            System.Threading.Thread t = new System.Threading.Thread(() => DoInstall(installDir));
            t.IsBackground = true;
            t.Start();
        }

        private void SetStatus(string msg)
        {
            if (this.InvokeRequired)
            {
                this.Invoke(new Action<string>(SetStatus), msg);
                return;
            }
            lblStatus.Text = msg;
            Application.DoEvents();
        }

        private void DoInstall(string installDir)
        {
            try
            {
                bool desktop = chkDesktop.Checked;
                bool startMenu = chkStartMenu.Checked;

                InstallLogic.Install(installDir, desktop, startMenu, msg => SetStatus(msg));

                this.Invoke(new Action(() =>
                {
                    progress.Style = ProgressBarStyle.Continuous;
                    progress.Value = 100;
                    lblStatus.Text = "安装完成！";
                }));

                System.Threading.Thread.Sleep(800);

                this.Invoke(new Action(() =>
                {
                    MessageBox.Show(this,
                        AppName + " 已安装完成！\n\n安装目录: " + installDir +
                        "\n\n浏览器将自动打开 http://127.0.0.1:" + InstallLogic.Port,
                        "安装完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    Application.Exit();
                }));
            }
            catch (Exception ex)
            {
                this.Invoke(new Action(() =>
                {
                    progress.Style = ProgressBarStyle.Continuous;
                    lblStatus.Text = "安装失败";
                    MessageBox.Show(this, "安装失败: " + ex.Message, "错误",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                    btnCancel.Enabled = true;
                    btnCancel.Text = "关闭";
                    installing = false;
                }));
            }
        }
    }
    internal static class InstallLogic
    {
        public const string AppName = "PS5 插件更新中心";
        public const string AppDirName = "PS5-Plugin-Hub";
        public const int Port = 8123;

        public static string DefaultInstallDir
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    AppDirName);
            }
        }

        public static byte[] GetEmbeddedZip()
        {
            string exePath = Assembly.GetExecutingAssembly().Location;
            byte[] exeData = File.ReadAllBytes(exePath);

            int zipStart = -1;
            for (int i = 0; i < exeData.Length - 4; i++)
            {
                if (exeData[i] == 0x50 && exeData[i + 1] == 0x4B &&
                    exeData[i + 2] == 0x03 && exeData[i + 3] == 0x04)
                {
                    zipStart = i;
                    break;
                }
            }
            if (zipStart < 0) return null;

            byte[] zipBytes = new byte[exeData.Length - zipStart];
            Array.Copy(exeData, zipStart, zipBytes, 0, zipBytes.Length);
            return zipBytes;
        }

        public static void SaveAppIcon(string installDir)
        {
            try
            {
                Icon icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
                if (icon != null)
                {
                    string iconPath = Path.Combine(installDir, "app.ico");
                    using (FileStream fs = new FileStream(iconPath, FileMode.Create))
                    {
                        icon.Save(fs);
                    }
                }
            }
            catch { }
        }

        public static void CreateShortcut(string shortcutPath, string targetPath, string args,
            string workingDir, string iconLocation, string description)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                object shell = Activator.CreateInstance(shellType);
                object shortcut = shellType.InvokeMember("CreateShortcut",
                    BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath });
                Type scType = shortcut.GetType();

                scType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut,
                    new object[] { targetPath });
                if (!string.IsNullOrEmpty(args))
                    scType.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut,
                        new object[] { args });
                if (!string.IsNullOrEmpty(workingDir))
                    scType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut,
                        new object[] { workingDir });
                if (!string.IsNullOrEmpty(iconLocation))
                    scType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut,
                        new object[] { iconLocation });
                if (!string.IsNullOrEmpty(description))
                    scType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut,
                        new object[] { description });

                scType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            catch { }
        }

        public static void Install(string installDir, bool createDesktop, bool createStartMenu, Action<string> status)
        {
            status("Preparing install files...");

            byte[] zipBytes = GetEmbeddedZip();
            if (zipBytes == null) throw new Exception("Installer data missing.");

            status("Extracting files...");
            Directory.CreateDirectory(installDir);

            string tempZip = Path.Combine(Path.GetTempPath(),
                "ps5-hub-setup-" + Guid.NewGuid().ToString("N") + ".zip");
            File.WriteAllBytes(tempZip, zipBytes);

            try
            {
                using (ZipArchive archive = ZipFile.OpenRead(tempZip))
                {
                    int total = archive.Entries.Count;
                    int done = 0;
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        string destPath = Path.Combine(installDir, entry.FullName);
                        string destDir = Path.GetDirectoryName(destPath);
                        if (!Directory.Exists(destDir))
                            Directory.CreateDirectory(destDir);

                        if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\"))
                            continue;

                        string rel = entry.FullName.Replace('/', '\\');
                        if (rel.StartsWith("local\\downloads\\", StringComparison.OrdinalIgnoreCase) ||
                            rel.StartsWith("local\\logs\\", StringComparison.OrdinalIgnoreCase) ||
                            rel.StartsWith("local\\state\\", StringComparison.OrdinalIgnoreCase))
                        {
                            if (File.Exists(destPath)) continue;
                        }
                        entry.ExtractToFile(destPath, overwrite: true);
                        done++;
                        if (done % 20 == 0)
                            status("Extracting files... (" + done + "/" + total + ")");
                    }
                }
            }
            finally
            {
                try { File.Delete(tempZip); } catch { }
            }

            status("Creating icon...");
            SaveAppIcon(installDir);

            string iconLocation = Path.Combine(installDir, "app.ico");
            string startBat = Path.Combine(installDir, "start.bat");

            if (createDesktop)
            {
                status("Creating desktop shortcut...");
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
                string lnk = Path.Combine(desktop, AppName + ".lnk");
                CreateShortcut(lnk, startBat, "", installDir, iconLocation, AppName);
            }

            if (createStartMenu)
            {
                status("Creating start menu shortcuts...");
                string startMenu = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                    AppName);
                Directory.CreateDirectory(startMenu);
                string lnk = Path.Combine(startMenu, AppName + ".lnk");
                CreateShortcut(lnk, startBat, "", installDir, iconLocation, AppName);

                string unLnk = Path.Combine(startMenu, "Uninstall " + AppName + ".lnk");
                string uninstallPs = Path.Combine(installDir, "uninstall.ps1");
                if (File.Exists(uninstallPs))
                {
                    CreateShortcut(unLnk, "powershell.exe",
                        "-ExecutionPolicy Bypass -File \"" + uninstallPs + "\"",
                        installDir, "", "Uninstall " + AppName);
                }
            }

            status("Starting app...");
            if (File.Exists(startBat))
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = "/c start \"\" \"" + startBat + "\"",
                    WorkingDirectory = installDir,
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
            }

            System.Threading.Thread.Sleep(1500);
            try { Process.Start("http://127.0.0.1:" + Port); } catch { }

            status("Done.");
        }
    }

    internal static class Program
    {
        private static string LogPath = Path.Combine(Path.GetTempPath(), "ps5-installer.log");

        private static void Log(string msg)
        {
            try
            {
                File.AppendAllText(LogPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + msg + Environment.NewLine);
            }
            catch { }
        }

        [STAThread]
        static void Main(string[] args)
        {
            Log("=== Installer started ===");
            Application.ThreadException += (s, e) =>
            {
                Log("ThreadException: " + e.Exception.ToString());
            };
            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
            {
                Log("UnhandledException: " + e.ExceptionObject.ToString());
            };

            try
            {
                bool silent = false;
                string customDir = null;
                foreach (string a in args)
                {
                    string lower = a.ToLowerInvariant();
                    if (lower == "/silent" || lower == "/quiet" || lower == "-silent" || lower == "-quiet")
                        silent = true;
                    else if (lower.StartsWith("/dir=") || lower.StartsWith("-dir="))
                        customDir = a.Substring(a.IndexOf('=') + 1);
                    else if (lower.StartsWith("/d=") || lower.StartsWith("-d="))
                        customDir = a.Substring(a.IndexOf('=') + 1);
                }

                if (silent)
                {
                    string installDir = string.IsNullOrEmpty(customDir) ? InstallLogic.DefaultInstallDir : customDir;
                    Log("Silent install to: " + installDir);
                    InstallLogic.Install(installDir, true, true, msg => Log("  " + msg));
                    Log("=== Silent install complete ===");
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Log("Creating form...");
                using (var form = new InstallerForm())
                {
                    Log("Form created, running...");
                    Application.Run(form);
                }
                Log("=== Installer exited normally ===");
            }
            catch (Exception ex)
            {
                Log("Fatal exception: " + ex.ToString());
                MessageBox.Show("安装程序发生错误: " + ex.Message + "\n\n日志: " + LogPath,
                    "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}
