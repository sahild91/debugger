import * as os from 'os';

export type SupportedPlatform = 'win32-x64' | 'darwin-x64' | 'darwin-arm64' | 'linux-x64';

export class PlatformUtils {
    
    static getCurrentPlatform(): SupportedPlatform {
        const platform = os.platform();
        const arch = os.arch();

        switch (platform) {
            case 'win32':
                return 'win32-x64'; // Assume x64 for now, can be extended for ARM64
            
            case 'darwin':
                return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
            
            case 'linux':
                return 'linux-x64'; // Assume x64 for now, can be extended for other architectures
            
            default:
                throw new Error(`Unsupported platform: ${platform}-${arch}`);
        }
    }

    static getPlatformDisplayName(): string {
        const platform = this.getCurrentPlatform();
        
        const displayNames: Record<SupportedPlatform, string> = {
            'win32-x64': 'Windows x64',
            'darwin-x64': 'macOS Intel',
            'darwin-arm64': 'macOS Apple Silicon',
            'linux-x64': 'Linux x64'
        };

        return displayNames[platform];
    }

    static isWindows(): boolean {
        return os.platform() === 'win32';
    }

    static isMacOS(): boolean {
        return os.platform() === 'darwin';
    }

    static isLinux(): boolean {
        return os.platform() === 'linux';
    }

    static getExecutableExtension(): string {
        return this.isWindows() ? '.exe' : '';
    }

    static getArchiveExtension(): string {
        return this.isWindows() ? '.zip' : '.tar.gz';
    }

    static getPathSeparator(): string {
        return this.isWindows() ? ';' : ':';
    }

    static normalizePath(filePath: string): string {
        if (this.isWindows()) {
            // On Windows, convert forward slashes to backslashes
            return filePath.replace(/\//g, '\\');
        }
        return filePath;
    }

    static getHomeDirectory(): string {
        return os.homedir();
    }

    static getTempDirectory(): string {
        return os.tmpdir();
    }

    static getDefaultShell(): string {
        if (this.isWindows()) {
            return process.env.COMSPEC || 'cmd.exe';
        }
        return process.env.SHELL || '/bin/sh';
    }

    static getEnvironmentVariable(name: string): string | undefined {
        return process.env[name];
    }

    static setEnvironmentVariable(name: string, value: string): void {
        process.env[name] = value;
    }

    static appendToPath(newPath: string): void {
        const currentPath = process.env.PATH || '';
        const separator = this.getPathSeparator();
        
        if (!currentPath.includes(newPath)) {
            process.env.PATH = currentPath ? `${newPath}${separator}${currentPath}` : newPath;
        }
    }

    static getPlatformSpecificConfig() {
        const platform = this.getCurrentPlatform();
        
        return {
            platform,
            displayName: this.getPlatformDisplayName(),
            isWindows: this.isWindows(),
            isMacOS: this.isMacOS(),
            isLinux: this.isLinux(),
            executableExt: this.getExecutableExtension(),
            archiveExt: this.getArchiveExtension(),
            pathSeparator: this.getPathSeparator(),
            shell: this.getDefaultShell(),
            home: this.getHomeDirectory(),
            temp: this.getTempDirectory()
        };
    }
}