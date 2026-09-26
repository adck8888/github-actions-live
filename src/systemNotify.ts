import { spawn } from 'child_process';

/**
 * Shows a notification of the operating system, for when VS Code is in the
 * background and its own notifications would go unseen until you come back.
 * The text goes through environment variables, never through a command line
 * a shell would read, so titles of commits cannot inject anything.
 */
export function notifySystem(title: string, body: string): void {
  const env = { ...process.env, AL_TITLE: title.slice(0, 200), AL_BODY: body.slice(0, 400) };
  const run = (command: string, args: string[]): void => {
    try {
      const child = spawn(command, args, { env, stdio: 'ignore', windowsHide: true, detached: false });
      child.on('error', () => undefined);
      child.unref();
    } catch {
      // No notifier on this system: the in-editor notification still shows.
    }
  };
  switch (process.platform) {
    case 'win32':
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_TOAST]);
      break;
    case 'darwin':
      run('osascript', ['-e', 'display notification (system attribute "AL_BODY") with title (system attribute "AL_TITLE")']);
      break;
    default:
      run('notify-send', ['--app-name=GitHub Actions Live', title, body]);
  }
}

// Toasts need an app id Windows knows; PowerShell's own is always registered.
const WINDOWS_TOAST = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $template.GetElementsByTagName('text')
$texts.Item(0).AppendChild($template.CreateTextNode($env:AL_TITLE)) | Out-Null
$texts.Item(1).AppendChild($template.CreateTextNode($env:AL_BODY)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)
`;
