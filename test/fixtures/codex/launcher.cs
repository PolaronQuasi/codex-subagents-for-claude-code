// Test-only native-format launcher. It can execute only the fixture Node entry
// supplied by the isolated harness; it never discovers or invokes real Codex.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

class FakeCodexLauncher {
    static async Task Pump(Stream input, Stream output) {
        var buffer = new byte[4096];
        int count;
        while ((count = await input.ReadAsync(buffer, 0, buffer.Length)) != 0) {
            await output.WriteAsync(buffer, 0, count);
            await output.FlushAsync();
        }
    }
    static string Quote(string value) {
        var text = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            text.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            text.Append(c);
            slashes = 0;
        }
        text.Append('\\', slashes * 2);
        return text.Append('"').ToString();
    }
    static int Main(string[] args) {
        string node = Environment.GetEnvironmentVariable("CODEX_FIXTURE_NODE");
        string entry = Environment.GetEnvironmentVariable("CODEX_FIXTURE_ENTRY");
        if (String.IsNullOrEmpty(node) || String.IsNullOrEmpty(entry)) return 2;
        var command = new StringBuilder(Quote(entry));
        foreach (string arg in args) command.Append(" ").Append(Quote(arg));
        var info = new ProcessStartInfo(node, command.ToString());
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardInput = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        using (var child = Process.Start(info)) {
            var output = Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
            var error = Pump(child.StandardError.BaseStream, Console.OpenStandardError());
            Task.Run(async () => {
                try {
                    await Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream);
                    child.StandardInput.Close();
                } catch (System.IO.IOException) { }
            });
            child.WaitForExit();
            Task.WaitAll(output, error);
            return child.ExitCode;
        }
    }
}
