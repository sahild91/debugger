# Port11 Debugger

A VS Code extension for programming and debugging MSPM0 microcontroller boards.

## What Does This Do?

This extension lets you:
- Build your code
- Upload (flash) programs to your board
- Debug your programs
- View memory and registers

All from within VS Code - no external tools needed.

## Installation

1. Download the `.vsix` file from releases
2. Open VS Code
3. Go to Extensions (click the blocks icon on the left, or press Ctrl+Shift+X)
4. Click the "..." menu at the top → "Install from VSIX..."
5. Select the downloaded file

## First Time Setup

When you first use the extension:

1. The extension will download and install the required tools automatically
2. This takes a few minutes
3. Once done, you're ready to go!

You can check setup status in the "Port11: Setup" panel on the left sidebar.

## How to Use

### 1. Connect Your Board

1. Plug your MSPM0 board into your computer via USB
2. The extension will automatically detect it
3. If not detected, click "Boards" panel and click "Detect"

### 2. Open Your Project

1. Open a folder containing your `.c` source files
2. The extension recognizes MSPM0 projects automatically

### 3. Build Your Code

**Option A:** Click the "Build" button in the status bar at the bottom
**Option B:** Press `Ctrl+Shift+B`
**Option C:** Open Command Palette (Ctrl+Shift+P) → type "Port11: Build"

The extension compiles your code. Any errors will show in the Problems panel.

### 4. Upload to Board (Flash)

After building successfully:

1. Click the "Flash" button in the status bar
2. Wait for the upload to complete
3. Your program is now running on the board!

### 5. Debug Your Program

**Start Debugging:**
1. Click the "Debug" button in the status bar
2. Your program will pause at the start

**While Debugging:**
- **Halt** - Pause the program
- **Resume** - Continue running
- **Step** - Execute one instruction at a time

**View Information:**
- **Data View** - See register values and variables
- **Breakpoints** - Manage breakpoints
- **Call Stack** - See function call history
- **Console** - View debug messages

### 6. Setting Breakpoints

1. Open a `.c` file
2. Click to the left of a line number (a red dot appears)
3. Run debug - program will pause at that line
4. Use "Resume" to continue to the next breakpoint

## Common Issues

### "Board not detected"
1. Make sure your board is plugged in via USB
2. Try a different USB cable or port
3. Click "Detect" in the Boards panel

### "Build failed"
1. Check the Problems panel for specific errors
2. Make sure your `.c` files are in the open folder
3. Try running setup again from the Setup panel

### "Flash failed"
1. Make sure your board is connected
2. Build your project first (Flash button only works after a successful build)
3. Check that no other program is using the board

### "Setup taking too long"
1. The first-time setup downloads large files (this is normal)
2. Make sure you have a stable internet connection
3. Check that you have at least 2GB of free disk space

### "Debug not working"
1. Flash your program to the board first
2. Make sure the board is connected
3. Try clicking "Halt" first, then look at the Data View

## Tips

- **Save your work often** - Build and flash frequently to catch errors early
- **Use breakpoints** - They help you see what's happening step-by-step
- **Check the Console** - It shows detailed information about what the extension is doing
- **Status bar buttons** - The quickest way to Build, Flash, and Debug

## Supported Boards

This extension works with:
- Port11 Extension Board

## Supported Systems

- Windows 10/11
- macOS (Intel and Apple Silicon)
- Linux (Ubuntu, Debian, Fedora)

## Need Help?

- Check the Console panel (View → Output → select "Port11 Debugger")
- Look at the Setup panel to verify everything is installed
- Report issues on GitHub

## Version

Current version: 0.1.0

## License

MIT License - Free to use and modify