using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Reflection;

namespace Ps5PluginHub
{
    class Program
    {
        static void Main(string[] args)
        {
            string installDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "PS5-Plugin-Hub");

            try
            {
                // Read this EXE
                string exePath = Assembly.GetExecutingAssembly().Location;
                byte[] exeData = File.ReadAllBytes(exePath);

                // Find the FIRST ZIP signature (PK\x03\x04)
                // The wrapper EXE won't contain this signature, so the first
                // occurrence marks the start of the appended ZIP archive.
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

                if (zipStart < 0)
                {
                    Console.WriteLine("Error: App data not found.");
                    Console.ReadKey();
                    return;
                }

                // Extract ZIP bytes
                byte[] zipBytes = new byte[exeData.Length - zipStart];
                Array.Copy(exeData, zipStart, zipBytes, 0, zipBytes.Length);

                // Create install directory
                Directory.CreateDirectory(installDir);

                // Save ZIP to temp
                string tempZip = Path.Combine(Path.GetTempPath(),
                    "ps5-hub-" + Guid.NewGuid().ToString("N") + ".zip");
                File.WriteAllBytes(tempZip, zipBytes);

                try
                {
                    // Extract using ZipArchive (overwrite existing files)
                    using (ZipArchive archive = ZipFile.OpenRead(tempZip))
                    {
                        foreach (ZipArchiveEntry entry in archive.Entries)
                        {
                            string destPath = Path.Combine(installDir, entry.FullName);
                            string destDir = Path.GetDirectoryName(destPath);
                            if (!Directory.Exists(destDir))
                                Directory.CreateDirectory(destDir);

                            if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\"))
                                continue;

                            entry.ExtractToFile(destPath, overwrite: true);
                        }
                    }
                }
                finally
                {
                    File.Delete(tempZip);
                }

                // Run start.bat via cmd.exe with 'start' to detach it
                string startBat = Path.Combine(installDir, "start.bat");
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
            }
            catch (Exception ex)
            {
                string logPath = Path.Combine(Path.GetTempPath(), "ps5-hub-error.log");
                File.WriteAllText(logPath, ex.ToString());
                Console.WriteLine("Error: " + ex.Message);
                Console.WriteLine("Log: " + logPath);
                Console.ReadKey();
            }
        }
    }
}
