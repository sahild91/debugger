# Port11 Debugger - VS Code Extension

A comprehensive VS Code extension for MSPM0 development with integrated build, flash, and debug capabilities.

## Features

- **Zero-Configuration Setup**: Automatic installation of MSPM0 SDK and ARM-CGT-CLANG toolchain
- **Integrated Build System**: Build projects directly from VS Code with error/warning parsing
- **Board Auto-Detection**: Automatically detect and connect to MSPM0 development boards
- **Flash Programming**: Flash firmware to boards with progress tracking
- **Advanced Debugging**: Debug with memory/register viewing via integrated DAP CLI
- **Cross-Platform Support**: Works on Windows, macOS, and Linux

## Installation

### From VSIX Package
1. Download the latest `.vsix` package from releases
2. In VS Code, go to Extensions view (Ctrl+Shift+X)
3. Click the "..." menu and select "Install from VSIX..."
4. Select the downloaded `.vsix` file

### From Marketplace
*Coming soon - extension will be published to VS Code Marketplace*

## Quick Start

1. **Install the Extension**: Install Port11 Debugger from VS Code Extensions
2. **Open Your Project**: Open a folder containing MSPM0 source code
3. **First-Time Setup**: The extension will prompt you to set up the toolchain
4. **Start Developing**: Use the Port11 panel for build, flash, and debug operations

## Usage

### Setting Up the Toolchain

On first use, the extension will automatically:

1. **Clone MSPM0 SDK** from GitHub repository
2. **Download ARM-CGT-CLANG** toolchain for your platform
3. **Validate Installation** and show version information

Access the setup via:
- Command Palette: `Port11: Setup Toolchain`
- Port11 panel in Explorer sidebar
- Status bar notifications

### Building Projects

Build your MSPM0 projects with:
- Command Palette: `Port11: Build Project`
- Port11 panel "Build" button
- Keyboard shortcut: `Ctrl+Shift+B`

Features:
- Automatic project detection
- ARM-CGT-CLANG integration
- Error/warning parsing in Problems panel
- Build progress tracking

### Flashing Firmware

Flash your compiled firmware:
- Command Palette: `Port11: Flash Firmware`
- Port11 panel "Flash" button

Features:
- Automatic board detection
- Support for multiple binary formats (.out, .elf, .bin)
- Flash verification
- Progress tracking with size information

### Debugging

Start debugging sessions:
- Command Palette: `Port11: Start Debug Session`
- Port11 panel "Debug" button

Features:
- SWD debugging via integrated Rust DAP CLI
- Memory and register viewing
- Target halt/resume control
- Program counter tracking
- Real-time register updates

## Configuration

### Extension Settings

Configure the extension through VS Code settings:

```json
{
  "port11-debugger.autoUpdate": true,
  "port11-debugger.serialPort": "/dev/ttyUSB0",
  "port11-debugger.debugVerbose": false,
  "port11-debugger.offlineMode": false,
  "port11-debugger.buildOutputLevel": "normal"
}
```

### Project Structure

The extension works with standard MSPM0 project structures:

```
your-project/
├── main.c
├── ti_msp_dl_config.c
├── ti_msp_dl_config.h
├── makefile (optional)
└── build/ (generated)
    └── main.out
```

## Board Support

### Supported Boards

- TI MSPM0 LaunchPad series
- TI XDS110 debug probes
- Generic FTDI USB-Serial adapters
- Silicon Labs CP210x adapters

### Board Detection

The extension automatically detects boards by:
- USB Vendor/Product ID matching
- Serial port enumeration
- Board-specific identification

### Manual Board Configuration

Override automatic detection:

```json
{
  "port11-debugger.serialPort": "/dev/ttyUSB0"
}
```

## Troubleshooting

### Setup Issues

**SDK Clone Failed**
- Check internet connectivity
- Verify GitHub access
- Try manual setup with offline mode

**Toolchain Download Failed**
- Check firewall/proxy settings
- Verify disk space availability
- Try downloading manually from TI website

### Build Issues

**Compiler Not Found**
- Verify toolchain installation in Port11 panel
- Check PATH environment variable
- Re-run setup process

**Include Paths Missing**
- Verify SDK installation
- Check project structure
- Review include path configuration

### Flash Issues

**Board Not Detected**
- Check USB connections
- Verify board power
- Install USB drivers if needed
- Try different USB ports

**Flash Failed**
- Verify board is in programming mode
- Check binary file exists and is valid
- Ensure no other tools are using the port

### Debug Issues

**DAP Connection Failed**
- Verify SWD connections
- Check board power and reset state
- Ensure no other debuggers are connected
- Try different baud rates

**Register Reads Timeout**
- Check board responsiveness
- Verify SWD clock speed
- Try halting target first

## Development

### Building from Source

Requirements:
- Node.js 20+
- npm or yarn
- VS Code Extension Development Host

Steps:
```bash
git clone <repository-url>
cd port11-debugger
npm install
npm run compile
```

### Testing

Run tests:
```bash
npm test
```

Test in Extension Development Host:
- Press F5 in VS Code
- Opens new window with extension loaded
- Test all functionality

### Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Architecture

### Core Components

- **Extension Host**: Main VS Code extension entry point
- **SDK Manager**: Handles MSPM0 SDK installation and updates
- **Toolchain Manager**: Manages ARM-CGT-CLANG installation
- **Serial Manager**: Board detection and communication
- **Build System**: Compiler integration and error parsing
- **Flash System**: Firmware programming with progress tracking
- **Debug System**: DAP CLI integration for SWD debugging
- **Webview UI**: Main user interface panel

### File Structure

```
src/
├── extension.ts              # Main extension entry
├── managers/
│   ├── sdkManager.ts        # MSPM0 SDK management
│   ├── toolchainManager.ts  # ARM-CGT-CLANG management
│   └── serialManager.ts     # Board/serial management
├── commands/
│   ├── buildCommand.ts      # Build integration
│   ├── flashCommand.ts      # Flash integration
│   └── debugCommand.ts      # Debug integration
├── webview/
│   └── webviewProvider.ts   # UI management
├── utils/
│   ├── platformUtils.ts     # Platform detection
│   └── downloadUtils.ts     # HTTP downloads
└── types/
    └── index.ts             # TypeScript definitions
```

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

- **Issues**: Report bugs and request features on GitHub Issues
- **Documentation**: Check this README and inline documentation
- **Community**: Join discussions in GitHub Discussions

## Changelog

### Version 0.1.0 (MVP)
- Initial release
- Basic build, flash, and debug functionality
- Auto-setup for SDK and toolchain
- Cross-platform support
- Webview-based UI

## Roadmap

### Near Term
- License compliance integration
- Compiled DAP binaries for all platforms
- Enhanced error handling and recovery
- Improved board detection

### Long Term
- Advanced debugging features (breakpoints, watchpoints)
- Project templates and wizards
- Integration with TI SysConfig
- Support for additional MCU families
- Cloud-based compilation options