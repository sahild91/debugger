import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as https from "https";

const DOWNLOAD_URLS = {
  darwin: "https://storage.googleapis.com/port11/swd-debugger-mac_aarch64",
  win32: "https://storage.googleapis.com/port11/swd-debugger.exe",
  linux: "https://storage.googleapis.com/port11/swd-debugger-linux_x86_64",
};

const DEST_FILE_NAME = "swd-debugger";

export class CliManager {
  private context: vscode.ExtensionContext;
  private setupRunKey = "swd-debugger.setupRun";
  private readonly SWD_DEBUGGER_PATH_KEY = "mspm0.swdDebuggerPath";
  private readonly SWD_DEBUGGER_LAST_DETECTED_KEY =
    "mspm0.swdDebuggerLastDetected";

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Save SWD Debugger path to globalState
   */
  private async saveSwdDebuggerPath(debuggerPath: string): Promise<void> {
    try {
      await this.context.globalState.update(
        this.SWD_DEBUGGER_PATH_KEY,
        debuggerPath
      );
      await this.context.globalState.update(
        this.SWD_DEBUGGER_LAST_DETECTED_KEY,
        new Date().toISOString()
      );
      console.log(`💾 Saved SWD Debugger path: ${debuggerPath}`);
    } catch (error) {
      console.error(`⚠️  Failed to save SWD Debugger path: ${error}`);
    }
  }

  /**
   * Load saved SWD Debugger path
   */
  private async loadSavedSwdDebuggerPath(): Promise<string | undefined> {
    const savedPath = this.context.globalState.get<string>(
      this.SWD_DEBUGGER_PATH_KEY
    );
    if (savedPath && fs.existsSync(savedPath)) {
      console.log(`📂 Loaded saved SWD Debugger path: ${savedPath}`);
      return savedPath;
    }
    return undefined;
  }

  private getInstallDir(): string {
    return path.join(this.context.extensionPath, "dist");
  }

  private getInstallPath(): string {
    const fileName =
      process.platform === "win32" ? `${DEST_FILE_NAME}.exe` : DEST_FILE_NAME;
    return path.join(this.context.extensionPath, "dist", fileName);
  }

  private getDownloadUrl(): string {
    const platform = process.platform as keyof typeof DOWNLOAD_URLS;
    return DOWNLOAD_URLS[platform] || DOWNLOAD_URLS.linux;
  }

  async initialize(): Promise<void> {
    const installPath = this.getInstallPath();

    const savedPath = await this.loadSavedSwdDebuggerPath();
    if (savedPath && fs.existsSync(savedPath)) {
      console.log(`✅ Using saved SWD Debugger: ${savedPath}`);
      return; // Already installed and path saved
    }

    if (!fs.existsSync(installPath)) {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Setting up swd-debugger...",
            cancellable: false,
          },
          async (progress) => {
            progress.report({ message: "Downloading swd-debugger..." });
            await this.setupSwdDebugger(progress);
            progress.report({ message: "Verifying installation..." });
          }
        );

        // Verify installation after setup
        if (!this.verifyInstallation()) {
          throw new Error(
            "Installation verification failed - executable not found or not executable"
          );
        }

        await this.saveSwdDebuggerPath(installPath);

        await this.context.globalState.update(this.setupRunKey, true);
        vscode.window.showInformationMessage(
          "swd-debugger installed and verified successfully!"
        );
      } catch (error: any) {
        const errorMsg = `Failed to setup swd-debugger: ${error.message}`;
        vscode.window.showErrorMessage(errorMsg);
        throw new Error(errorMsg);
      }
    }
  }

  private async setupSwdDebugger(
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<void> {
    const installDir = this.getInstallDir();
    const installPath = this.getInstallPath();

    try {
      // Create install directory
      progress.report({ message: "Creating installation directory..." });
      if (!fs.existsSync(installDir)) {
        fs.mkdirSync(installDir, { recursive: true });
      }

      // Download file with verification
      progress.report({ message: "Downloading executable..." });
      const downloadUrl = this.getDownloadUrl();
      await this.downloadFile(downloadUrl, installPath);

      // Make executable (Unix-like systems only)
      if (process.platform !== "win32") {
        progress.report({ message: "Setting permissions..." });
        fs.chmodSync(installPath, "755");
      }
    } catch (error: any) {
      // Clean up on failure
      if (fs.existsSync(installPath)) {
        try {
          fs.unlinkSync(installPath);
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
      }
      throw new Error(`Setup failed: ${error.message}`);
    }
  }

  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      https
        .get(url, (response) => {
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `Download failed with status code: ${response.statusCode}`
              )
            );
            return;
          }
          response.pipe(file);
          file.on("finish", () => {
            file.close(() => resolve());
          });
        })
        .on("error", (err) => {
          fs.unlink(dest, () => reject(err));
        });
    });
  }

  private verifyInstallation(): boolean {
    const installPath = this.getInstallPath();

    try {
      // Check if file exists
      if (!fs.existsSync(installPath)) {
        return false;
      }

      // Check file stats
      const stats = fs.statSync(installPath);
      if (stats.size === 0) {
        return false;
      }

      // Check if file is executable (on Unix-like systems)
      if (process.platform !== "win32") {
        try {
          fs.accessSync(installPath, fs.constants.X_OK);
        } catch {
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  isCliAvailable(): boolean {
    return this.verifyInstallation();
  }

  getExecutablePath(): string {
    const savedPath = this.context.globalState.get<string>(
      this.SWD_DEBUGGER_PATH_KEY
    );
    if (savedPath && fs.existsSync(savedPath)) {
      return savedPath;
    }
    return this.getInstallPath();
  }
}
