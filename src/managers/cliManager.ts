import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as https from "https";

const DOWNLOAD_URLS = {
  darwin:
    "https://storage.googleapis.com/port11/swd-debugger-mac_aarch64",
  win32:
    "https://storage.googleapis.com/port11/swd-debugger.exe",
  linux:
    "https://storage.googleapis.com/port11/swd-debugger-linux_x86_64",
};

const CHANGELOG_URL = "https://storage.googleapis.com/port11/change_log.json";
const DEST_FILE_NAME = "swd-debugger";

interface ChangelogData {
  current_version: string;
  versions: {
    [version: string]: string;
  };
}

export class CliManager {
  private context: vscode.ExtensionContext;
  private setupRunKey = "swd-debugger.setupRun";
  private readonly SWD_DEBUGGER_PATH_KEY = "mspm0.swdDebuggerPath";
  private readonly SWD_DEBUGGER_LAST_DETECTED_KEY =
    "mspm0.swdDebuggerLastDetected";
  private readonly SWD_DEBUGGER_VERSION_KEY = "mspm0.swdDebuggerVersion";

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
   * Save current SWD Debugger version to globalState
   */
  private async saveSwdDebuggerVersion(version: string): Promise<void> {
    try {
      await this.context.globalState.update(
        this.SWD_DEBUGGER_VERSION_KEY,
        version
      );
      console.log(`💾 Saved SWD Debugger version: ${version}`);
    } catch (error) {
      console.error(`⚠️  Failed to save SWD Debugger version: ${error}`);
    }
  }

  /**
   * Get stored SWD Debugger version from globalState
   */
  private getStoredVersion(): string | undefined {
    return this.context.globalState.get<string>(this.SWD_DEBUGGER_VERSION_KEY);
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
      process.platform === "win32"
        ? `${DEST_FILE_NAME}.exe`
        : DEST_FILE_NAME;
    return path.join(this.context.extensionPath, "dist", fileName);
  }

  private getDownloadUrl(): string {
    const platform = process.platform as keyof typeof DOWNLOAD_URLS;
    return DOWNLOAD_URLS[platform] || DOWNLOAD_URLS.linux;
  }

  /**
   * Fetch changelog data from remote URL
   */
  private fetchChangelog(): Promise<ChangelogData> {
    return new Promise((resolve, reject) => {
      https
        .get(CHANGELOG_URL, (response) => {
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `Failed to fetch changelog: HTTP ${response.statusCode}`
              )
            );
            return;
          }

          let data = "";
          response.on("data", (chunk) => {
            data += chunk;
          });

          response.on("end", () => {
            try {
              const changelog: ChangelogData = JSON.parse(data);
              resolve(changelog);
            } catch (error) {
              reject(new Error(`Failed to parse changelog JSON: ${error}`));
            }
          });
        })
        .on("error", (err) => {
          reject(new Error(`Network error fetching changelog: ${err.message}`));
        });
    });
  }

  /**
   * Compare two version strings (e.g., "0.1.0" vs "0.1.1")
   * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
   */
  private compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split(".").map(Number);
    const parts2 = v2.split(".").map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const part1 = parts1[i] || 0;
      const part2 = parts2[i] || 0;

      if (part1 > part2) return 1;
      if (part1 < part2) return -1;
    }

    return 0;
  }

  /**
   * Check if an update is available
   */
  private async checkForUpdate(): Promise<{
    updateAvailable: boolean;
    latestVersion?: string;
    description?: string;
  }> {
    try {
      console.log("🔍 Checking for SWD Debugger updates...");
      
      const changelog = await this.fetchChangelog();
      const latestVersion = changelog.current_version;
      const storedVersion = this.getStoredVersion();

      console.log(`Latest version: ${latestVersion}`);
      console.log(`Stored version: ${storedVersion || "none"}`);

      if (!storedVersion) {
        // No version stored, treat as new installation
        return {
          updateAvailable: true,
          latestVersion,
          description: changelog.versions[latestVersion],
        };
      }

      const comparison = this.compareVersions(latestVersion, storedVersion);
      
      if (comparison > 0) {
        // New version available
        console.log(`✨ Update available: ${storedVersion} → ${latestVersion}`);
        return {
          updateAvailable: true,
          latestVersion,
          description: changelog.versions[latestVersion],
        };
      }

      console.log("✅ SWD Debugger is up to date");
      return { updateAvailable: false };
    } catch (error) {
      console.error(`⚠️  Failed to check for updates: ${error}`);
      // On error, don't block initialization
      return { updateAvailable: false };
    }
  }

  /**
   * Delete the old debugger binary
   */
  private async deleteOldDebugger(): Promise<void> {
    const installPath = this.getInstallPath();
    
    if (fs.existsSync(installPath)) {
      try {
        console.log(`🗑️  Deleting old debugger: ${installPath}`);
        fs.unlinkSync(installPath);
        console.log("✅ Old debugger deleted");
      } catch (error) {
        throw new Error(`Failed to delete old debugger: ${error}`);
      }
    }
  }

  /**
   * Download and install the latest debugger version
   */
  private async downloadLatestDebugger(
    version: string,
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

      // Download file
      progress.report({ message: `Downloading SWD Debugger v${version}...` });
      const downloadUrl = this.getDownloadUrl();
      await this.downloadFile(downloadUrl, installPath);

      // Make executable (Unix-like systems only)
      if (process.platform !== "win32") {
        progress.report({ message: "Setting permissions..." });
        fs.chmodSync(installPath, "755");
      }

      // Save version and path
      await this.saveSwdDebuggerVersion(version);
      await this.saveSwdDebuggerPath(installPath);
      
      console.log(`✅ SWD Debugger v${version} installed successfully`);
    } catch (error: any) {
      // Clean up on failure
      if (fs.existsSync(installPath)) {
        try {
          fs.unlinkSync(installPath);
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
      }
      throw new Error(`Download failed: ${error.message}`);
    }
  }

  async initialize(): Promise<void> {
    try {
      console.log("🚀 Initializing SWD Debugger CLI Manager...");

      // Check for updates
      const updateCheck = await this.checkForUpdate();

      if (updateCheck.updateAvailable && updateCheck.latestVersion) {
        // Update needed
        const version = updateCheck.latestVersion;
        const description = updateCheck.description || "New version available";

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Updating swd-debugger to v${version}...`,
            cancellable: false,
          },
          async (progress) => {
            progress.report({ message: "Removing old version..." });
            await this.deleteOldDebugger();

            progress.report({ message: "Downloading latest version..." });
            await this.downloadLatestDebugger(version, progress);

            progress.report({ message: "Verifying installation..." });
          }
        );

        // Verify installation
        if (!this.verifyInstallation()) {
          throw new Error(
            "Installation verification failed - executable not found or not executable"
          );
        }

        // Show update notification
        vscode.window.showInformationMessage(
          `✨ SWD Debugger updated to v${version}: ${description}`
        );
      } else {
        // No update needed, but verify installation exists
        const installPath = this.getInstallPath();
        const savedPath = await this.loadSavedSwdDebuggerPath();

        if (!fs.existsSync(installPath) && !savedPath) {
          // First time installation
          const changelog = await this.fetchChangelog();
          const version = changelog.current_version;
          const description = changelog.versions[version];

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Setting up swd-debugger...",
              cancellable: false,
            },
            async (progress) => {
              progress.report({ message: "Downloading swd-debugger..." });
              await this.downloadLatestDebugger(version, progress);
              progress.report({ message: "Verifying installation..." });
            }
          );

          // Verify installation
          if (!this.verifyInstallation()) {
            throw new Error(
              "Installation verification failed - executable not found or not executable"
            );
          }

          vscode.window.showInformationMessage(
            `swd-debugger v${version} installed successfully!`
          );
        } else {
          console.log("✅ SWD Debugger is already installed and up to date");
        }
      }

      await this.context.globalState.update(this.setupRunKey, true);
    } catch (error: any) {
      const errorMsg = `Failed to setup swd-debugger: ${error.message}`;
      vscode.window.showErrorMessage(errorMsg);
      throw new Error(errorMsg);
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

  /**
   * Get current installed version
   */
  getCurrentVersion(): string | undefined {
    return this.getStoredVersion();
  }
}